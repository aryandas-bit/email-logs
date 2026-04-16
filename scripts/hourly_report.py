import json, re, os, urllib.request
from datetime import datetime, timezone, timedelta

ist = timezone(timedelta(hours=5, minutes=30))
now = datetime.now(ist)

slot_end   = now.replace(minute=0, second=0, microsecond=0)
slot_start = slot_end - timedelta(hours=1)

def fmt_hour(dt):
    return dt.strftime('%I').lstrip('0') or '0'

if slot_start.strftime('%p') != slot_end.strftime('%p'):
    slot_label = f"{fmt_hour(slot_start)} {slot_start.strftime('%p')}–{fmt_hour(slot_end)} {slot_end.strftime('%p')}"
else:
    slot_label = f"{fmt_hour(slot_start)}–{fmt_hour(slot_end)} {slot_end.strftime('%p')}"

time_range = f"{slot_start.strftime('%-d %b %Y, %I:%M %p')} → {slot_end.strftime('%I:%M %p')} IST"

# Fetch Firebase
url = 'https://yl-logs-default-rtdb.firebaseio.com/entries.json'
try:
    with urllib.request.urlopen(url) as r:
        data = json.loads(r.read())
except Exception as e:
    print(f"Failed to fetch Firebase data: {e}")
    exit(1)

if not data:
    print("No data in Firebase — skipping post.")
    exit(0)

# Per (email, ticketId): track whether ever resolved / ever on hold within the slot
ticket_events = {}  # (email, tid) -> {'ever_resolved': bool, 'ever_onhold': bool, 'email': str}
seen_exact    = set()
for agent_key, entries in data.items():
    for entry in entries.values():
        tid = entry.get('ticketId', '')
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
        if not email.endswith('@ultrahuman.com'):
            continue
        exact_key = f"{email}|{tid}|{ts}"
        if exact_key in seen_exact:
            continue
        seen_exact.add(exact_key)
        key    = (email, tid)
        status = entry.get('status', '')
        if key not in ticket_events:
            ticket_events[key] = {'ever_resolved': False, 'ever_onhold': False, 'email': email}
        if status == 'Resolved':
            ticket_events[key]['ever_resolved'] = True
        elif status == 'On Hold':
            ticket_events[key]['ever_onhold'] = True

agents = {}
for (email, tid), info in ticket_events.items():
    local = info['email'].split('@')[0]
    local = re.sub(r'_ext$', '', local)
    name  = ' '.join(w.capitalize() for w in re.split(r'[._]', local))
    if name not in agents:
        agents[name] = {'total': 0, 'resolved': 0, 'onhold': 0}
    agents[name]['total'] += 1
    if info['ever_resolved']:
        agents[name]['resolved'] += 1
    if info['ever_onhold']:
        agents[name]['onhold'] += 1

sorted_agents = sorted(agents.items(), key=lambda x: x[1]['total'], reverse=True)

if not sorted_agents:
    print("No entries for this slot — skipping post.")
    exit(0)

total_resolved = sum(a['resolved'] for _, a in sorted_agents)
total_onhold   = sum(a['onhold']   for _, a in sorted_agents)

# Build table
c1, c2, c3, c4, c5 = 3, 22, 10, 9, 7
top = f"┌{'─'*(c1+2)}┬{'─'*(c2+2)}┬{'─'*(c3+2)}┬{'─'*(c4+2)}┬{'─'*(c5+2)}┐"
mid = f"├{'─'*(c1+2)}┼{'─'*(c2+2)}┼{'─'*(c3+2)}┼{'─'*(c4+2)}┼{'─'*(c5+2)}┤"
bot = f"└{'─'*(c1+2)}┴{'─'*(c2+2)}┴{'─'*(c3+2)}┴{'─'*(c4+2)}┴{'─'*(c5+2)}┘"

def row(a, b, c, d, e):
    return f"│ {str(a):<{c1}} │ {str(b):<{c2}} │ {str(c):>{c3}} │ {str(d):>{c4}} │ {str(e):>{c5}} │"

lines = [
    f"*{slot_label}*   ·   *{total_resolved} resolved*   ·   *{total_onhold} on hold*",
    f"_{time_range}_",
    "",
    "```",
    top,
    row("#", "Agent", "Resolved", "On Hold", "Total"),
    mid,
]
for i, (name, a) in enumerate(sorted_agents, 1):
    r = str(a['resolved']) if a['resolved'] else "—"
    h = str(a['onhold'])   if a['onhold']   else "—"
    lines.append(row(i, name, r, h, a['total']))
lines += [bot, "```"]

message = '\n'.join(lines)

# Post to Slack
webhook_url = os.environ['SLACK_WEBHOOK_URL']
payload = json.dumps({"text": message}).encode()
req = urllib.request.Request(webhook_url, payload, {'Content-Type': 'application/json'})
urllib.request.urlopen(req)
print("Posted successfully.")
