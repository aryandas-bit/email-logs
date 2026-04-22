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

GAP_THRESHOLD_HOURS = 2

def calc_working_hours(timestamps):
    if len(timestamps) < 2:
        return 0
    sorted_ts = sorted(timestamps)
    total_secs = 0
    session_start = sorted_ts[0]
    prev = sorted_ts[0]
    for ts in sorted_ts[1:]:
        if (ts - prev).total_seconds() / 3600 > GAP_THRESHOLD_HOURS:
            total_secs += (prev - session_start).total_seconds()
            session_start = ts
        prev = ts
    total_secs += (prev - session_start).total_seconds()
    return total_secs / 3600

def build_table(agent_list):
    c1, c2, c3, c4, c5 = 3, 22, 10, 9, 7
    top = f"┌{'─'*(c1+2)}┬{'─'*(c2+2)}┬{'─'*(c3+2)}┬{'─'*(c4+2)}┬{'─'*(c5+2)}┐"
    mid = f"├{'─'*(c1+2)}┼{'─'*(c2+2)}┼{'─'*(c3+2)}┼{'─'*(c4+2)}┼{'─'*(c5+2)}┤"
    bot = f"└{'─'*(c1+2)}┴{'─'*(c2+2)}┴{'─'*(c3+2)}┴{'─'*(c4+2)}┴{'─'*(c5+2)}┘"

    def row(a, b, c, d, e):
        return f"│ {str(a):<{c1}} │ {str(b):<{c2}} │ {str(c):>{c3}} │ {str(d):>{c4}} │ {str(e):>{c5}} │"

    rows = [top, row("#", "Agent", "Resolved", "On Hold", "Total"), mid]
    for i, (name, a) in enumerate(agent_list, 1):
        total = a['resolved'] + a['onhold']
        r     = str(a['resolved']) if a['resolved'] else "—"
        h     = str(a['onhold'])   if a['onhold']   else "—"
        rows.append(row(i, name, r, h, total))
    rows.append(bot)
    return rows

def generate_report(report_date: date, post_to_slack: bool = True):
    slot_start = datetime(report_date.year, report_date.month, report_date.day, 7, 0, 0, tzinfo=ist)
    slot_end   = slot_start + timedelta(days=1)

    date_label = f"{ordinal(slot_start.day)} {slot_start.strftime('%b %Y')}"
    time_range = (
        f"{slot_start.strftime('%-d %b %Y, %I:%M %p')} → "
        f"{slot_end.strftime('%-d %b %Y, %I:%M %p')} IST"
    )

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

    # Per (email, tid): track ever-resolved / ever-on-hold (mirrors hourly_report.py logic)
    ticket_events = {}
    seen_exact    = set()

    for agent_key, entries in data.items():
        if not isinstance(entries, dict):
            continue
        for entry in entries.values():
            tid = str(entry.get('ticketId', ''))
            ts  = entry.get('timestamp', '')

            if not re.match(r'^\d{1,5}$', tid):
                continue
            if re.match(r'^Ticket-\d+$', tid, re.I):
                continue

            try:
                entry_dt = datetime.strptime(ts.strip(), '%d %b %Y, %I:%M:%S %p').replace(tzinfo=ist)
            except ValueError:
                continue

            if not (slot_start <= entry_dt < slot_end):
                continue

            email = entry.get('agentEmail') or agent_key
            if not isinstance(email, str) or not email.endswith('@ultrahuman.com'):
                continue

            exact_key = f"{email}|{tid}|{ts}"
            if exact_key in seen_exact:
                continue
            seen_exact.add(exact_key)

            key    = (email, tid)
            status = entry.get('status', '')
            if key not in ticket_events:
                ticket_events[key] = {'ever_resolved': False, 'ever_onhold': False, 'email': email, 'ts_list': []}
            if status == 'Resolved':
                ticket_events[key]['ever_resolved'] = True
            elif status == 'On Hold':
                ticket_events[key]['ever_onhold'] = True
            ticket_events[key]['ts_list'].append(entry_dt)

    agents = {}
    for (email, tid), info in ticket_events.items():
        name = email_to_name(info['email'])
        if name not in agents:
            first = info['ts_list'][0]
            agents[name] = {'resolved': 0, 'onhold': 0, 'ts_list': [], 'first_ts': first, 'last_ts': first}
        if info['ever_resolved']:
            agents[name]['resolved'] += 1
        if info['ever_onhold']:
            agents[name]['onhold']   += 1
        for t in info['ts_list']:
            agents[name]['ts_list'].append(t)
            if t < agents[name]['first_ts']:
                agents[name]['first_ts'] = t
            if t > agents[name]['last_ts']:
                agents[name]['last_ts'] = t

    total_resolved = sum(a['resolved'] for a in agents.values())
    total_onhold   = sum(a['onhold']   for a in agents.values())
    total_solved   = total_resolved + total_onhold

    if agents:
        overall_first = min(a['first_ts'] for a in agents.values())
        overall_last  = max(a['last_ts']  for a in agents.values())
        overall_hours = (overall_last - overall_first).total_seconds() / 3600
        avg_per_hour  = total_solved / overall_hours if overall_hours >= 0.25 else total_solved
    else:
        avg_per_hour  = 0

    email_agents = sorted(
        [(n, agents[n]) for n in agents if n in EMAIL_TEAM],
        key=lambda x: x[1]['resolved'] + x[1]['onhold'], reverse=True
    )
    non_email_agents = sorted(
        [(n, agents[n]) for n in agents if n not in EMAIL_TEAM],
        key=lambda x: x[1]['resolved'] + x[1]['onhold'], reverse=True
    )

    lines = [
        "Tickets in, tickets out — here's the daily scorecard.",
        "",
        f"*Daily Report — {date_label}*",
        f"_{time_range}_",
        "",
        f"*Tickets Solved: {total_solved}*   ·   *Resolved: {total_resolved}*   ·   *On Hold: {total_onhold}*",
        f"*Total Agents: {len(agents)}*",
    ]

    if email_agents:
        lines += ["", f"*Email Team ({len(email_agents)} agents)*", "```"]
        lines += build_table(email_agents)
        lines += ["```"]

    if non_email_agents:
        lines += ["", f"*Non-Email Agents ({len(non_email_agents)} agents)*", "```"]
        lines += build_table(non_email_agents)
        lines += ["```"]

    lines += ["", "cc: <@U08HCJ99XPC> <@U05BZT4NNDS> <@U03RNK6EJDB> <!subteam^D0967C3KV0Q|cx-emailteam>"]

    message = '\n'.join(lines)
    print(message)

    if post_to_slack:
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
        help='Report date (default: yesterday in IST)',
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
        now_ist = datetime.now(ist)
        report_date = (now_ist - timedelta(days=1)).date()

    generate_report(report_date, post_to_slack=not args.no_slack)
