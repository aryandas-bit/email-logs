import json, re, os, sys, argparse, urllib.request
from datetime import datetime, timezone, timedelta, date

ist = timezone(timedelta(hours=5, minutes=30))

EMAIL_TEAM = {
    "Asma Sultana",
    "Pooja Prajapati",
    "Sonia Singh",
    "Ketki Hiwarkar",
    "Sandeep Manda",
    "Nitasha Sharma",
    "Ankita Dave",
    "Nimisa Bora",
    "Aman Katiyar",
    "Salman Khan",
    "Ayush Jangid",
    "Divyansh Mishra",
    "Prateek Govila",
    "Swapna Mishra",
}

def email_to_name(email):
    local = email.split('@')[0]
    local = re.sub(r'_ext$', '', local)
    return ' '.join(w.capitalize() for w in re.split(r'[._]', local))

def ordinal(n):
    suffix = {1: 'st', 2: 'nd', 3: 'rd'}
    return str(n) + suffix.get(n % 10 if n % 100 not in (11, 12, 13) else 0, 'th')

def generate_report(report_date: date, post_to_slack: bool = True):
    # 7:00 AM IST on report_date → 7:00 AM IST on the following day
    slot_start = datetime(report_date.year, report_date.month, report_date.day, 7, 0, 0, tzinfo=ist)
    slot_end   = slot_start + timedelta(days=1)

    date_label = f"{ordinal(slot_start.day)} {slot_start.strftime('%b %Y')}"
    time_range = (
        f"{slot_start.strftime('%-d %b %Y, %I:%M %p')} → "
        f"{slot_end.strftime('%-d %b %Y, %I:%M %p')} IST"
    )

    # Fetch all entries from Firebase
    url = 'https://yl-logs-default-rtdb.firebaseio.com/entries.json'
    try:
        with urllib.request.urlopen(url) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"Failed to fetch Firebase data: {e}")
        sys.exit(1)

    if not data:
        print("No data in Firebase — skipping.")
        sys.exit(0)

    # Aggregate tickets per agent within the window
    agents = {}
    for agent_key, entries in data.items():
        if not isinstance(entries, dict):
            continue
        for entry in entries.values():
            tid = str(entry.get('ticketId', ''))
            ts  = entry.get('timestamp', '')

            # Ticket ID validation (same rules as hourly_report.py)
            if not re.match(r'^\d{1,5}$', tid):
                continue
            if re.match(r'^Ticket-\d+$', tid, re.I):
                continue

            # Parse timestamp
            try:
                entry_dt = datetime.strptime(ts.strip(), '%d %b %Y, %I:%M:%S %p').replace(tzinfo=ist)
            except ValueError:
                continue

            # Keep only entries within the window
            if not (slot_start <= entry_dt < slot_end):
                continue

            # Only @ultrahuman.com agents
            email = entry.get('agentEmail') or agent_key
            if not isinstance(email, str) or not email.endswith('@ultrahuman.com'):
                continue

            name = email_to_name(email)
            if name not in agents:
                agents[name] = {'resolved': 0, 'onhold': 0}

            status = entry.get('status', '')
            if status == 'Resolved':
                agents[name]['resolved'] += 1
            elif status == 'On Hold':
                agents[name]['onhold'] += 1

    total_resolved = sum(a['resolved'] for a in agents.values())
    total_onhold   = sum(a['onhold']   for a in agents.values())
    total_solved   = total_resolved + total_onhold

    # Sort each group by total tickets descending
    email_agents     = sorted(
        [(n, agents[n]) for n in agents if n in EMAIL_TEAM],
        key=lambda x: x[1]['resolved'] + x[1]['onhold'], reverse=True
    )
    non_email_agents = sorted(
        [(n, agents[n]) for n in agents if n not in EMAIL_TEAM],
        key=lambda x: x[1]['resolved'] + x[1]['onhold'], reverse=True
    )

    def bullet_list(agent_list):
        if not agent_list:
            return '    —'
        rows = []
        for name, a in agent_list:
            total  = a['resolved'] + a['onhold']
            detail = f"R:{a['resolved']} H:{a['onhold']}"
            rows.append(f"    • {name} — {total} ({detail})")
        return '\n'.join(rows)

    lines = [
        f"*Daily Report — {date_label}*",
        f"_Window: {time_range}_",
        "",
        f"*Tickets Solved: {total_solved}*",
        f"  • Resolved: {total_resolved}",
        f"  • On Hold: {total_onhold}",
        "",
        f"*Total Agents Working: {len(agents)}*",
        "",
        f"*Email Agents Working: {len(email_agents)}*",
        bullet_list(email_agents),
        "",
        f"*Non-Email Agents Working: {len(non_email_agents)}*",
        bullet_list(non_email_agents),
    ]

    # Tag Parth Saluja at the bottom of every daily report
    message = '\n'.join(lines) + "\n\n<@U08HCJ99XPC>"
    print(message)

    if post_to_slack:
        # Use a channel-specific webhook for #cx-email-team; fall back to the
        # generic webhook if the dedicated one is not set.
        webhook_url = (
            os.environ.get('DAILY_REPORT_SLACK_WEBHOOK_URL') or
            os.environ.get('SLACK_WEBHOOK_URL')
        )
        if not webhook_url:
            print("\nNo Slack webhook URL set — skipping Slack post.")
            return
        payload = json.dumps({"text": message}).encode()
        req = urllib.request.Request(webhook_url, payload, {'Content-Type': 'application/json'})
        urllib.request.urlopen(req)
        print("\nPosted to Slack successfully.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Generate daily ticket report (7 AM → next-day 7 AM IST)')
    parser.add_argument(
        '--date',
        type=str,
        metavar='YYYY-MM-DD',
        help='Report date (default: yesterday in IST, i.e. the window that just closed)',
        default=None,
    )
    parser.add_argument(
        '--no-slack',
        action='store_true',
        help='Print the report without posting to Slack',
    )
    args = parser.parse_args()

    if args.date:
        try:
            report_date = date.fromisoformat(args.date)
        except ValueError:
            print(f"Invalid date '{args.date}'. Use YYYY-MM-DD.")
            sys.exit(1)
    else:
        # Default: report on the window that just closed at 7 AM today
        now_ist = datetime.now(ist)
        report_date = (now_ist - timedelta(days=1)).date()

    generate_report(report_date, post_to_slack=not args.no_slack)
