#!/usr/bin/env python3
import argparse
import json
import os
from datetime import datetime, timedelta
import hashlib


CAL_HEADER = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'PRODID:-//psy_duty//Duty Roster//KO',
    'METHOD:PUBLISH',
]


def ics_escape(s: str) -> str:
    return (
        str(s)
        .replace('\\', r'\\')
        .replace('\n', r'\n')
        .replace(',', r'\,')
        .replace(';', r'\;')
    )


def dtstamp_utc() -> str:
    now = datetime.utcnow()
    return now.strftime('%Y%m%dT%H%M%SZ')


def date_ics(d: datetime) -> str:
    return d.strftime('%Y%m%d')


def build_person_ics(roster: dict, person_name: str) -> str:
    holidays = set(roster.get('holidays') or [])
    lines = list(CAL_HEADER)
    lines.append('X-WR-CALNAME:' + ics_escape(f'Psy Duty ({person_name})'))
    stamp = dtstamp_utc()
    roles = ['병당', '응당']

    for day in roster.get('schedule', []):
        date_str = day.get('date') or day.get('key')
        if not date_str:
            continue
        date_obj = datetime.strptime(date_str[:10], '%Y-%m-%d')
        wd = date_obj.weekday()  # 0 Mon..6 Sun
        is_weekend = wd >= 5
        is_holiday = (date_str[:10] in holidays)
        day_note = '공휴일' if is_holiday else ('주말' if is_weekend else '평일')

        duties = day.get('duties') or []
        for idx, duty in enumerate(duties):
            if not duty:
                continue
            if duty.get('name') != person_name:
                continue
            role = roles[idx] if idx < len(roles) else f'슬롯{idx+1}'
            title = f'{role} - {person_name}'
            desc = f"{date_obj.strftime('%Y-%m-%d')} {day_note}"
            d0 = date_ics(date_obj)
            d1 = date_ics(date_obj + timedelta(days=1))
            role_key = 'B' if idx == 0 else 'E'
            name = duty.get('name', '')
            name_hash = hashlib.sha1(name.encode('utf-8')).hexdigest()[:10]
            uid = f"duty-{d0}-{role_key}-{name_hash}@psy_duty"
            lines.extend([
                'BEGIN:VEVENT',
                'UID:' + uid,
                'DTSTAMP:' + stamp,
                'DTSTART;VALUE=DATE:' + d0,
                'DTEND;VALUE=DATE:' + d1,
                'SUMMARY:' + ics_escape(title),
                'DESCRIPTION:' + ics_escape(desc),
                'END:VEVENT',
            ])

    lines.append('END:VCALENDAR')
    return '\r\n'.join(lines)


def safe_name(name: str) -> str:
    return name.replace('/', '_').replace('\\', '_')


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description='Build per-person ICS files from exported roster JSON')
    p.add_argument('input_json', help='Exported JSON from the app (duty-roster.json)')
    p.add_argument('-o', '--out', default='dist/ics', help='Output directory (default: dist/ics)')
    args = p.parse_args(argv)

    with open(args.input_json, 'r', encoding='utf-8') as f:
        roster = json.load(f)

    os.makedirs(args.out, exist_ok=True)
    people = roster.get('employees') or []
    written = 0
    for pinfo in people:
        name = pinfo.get('name') if isinstance(pinfo, dict) else str(pinfo)
        # Skip if person has no duties
        has = False
        for day in roster.get('schedule', []):
            for d in (day.get('duties') or []):
                if d and d.get('name') == name:
                    has = True
                    break
            if has:
                break
        if not has:
            continue

        ics = build_person_ics(roster, name)
        out_path = os.path.join(args.out, f"{safe_name(name)}.ics")
        with open(out_path, 'w', encoding='utf-8') as wf:
            wf.write(ics)
        written += 1
    print(f"Wrote {written} ICS files to {os.path.abspath(args.out)}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
