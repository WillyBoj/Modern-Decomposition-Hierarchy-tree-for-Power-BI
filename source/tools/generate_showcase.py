#!/usr/bin/env python3
"""
Generate the synthetic showcase datasets in examples/.

Everything here is invented: the company, the teams, the people, the vendors and the
applications. Surnames come from a list of made-up words, e-mail addresses use the
reserved example.com domain, and the random seed is fixed so the output is reproducible.

    python3 tools/generate_showcase.py
"""

import csv
import random
from datetime import date, timedelta
from pathlib import Path

# Public repository layout: examples/ sits next to source/. Fall back to source/examples otherwise.
_SOURCE = Path(__file__).resolve().parent.parent
OUT = _SOURCE.parent / "examples" if (_SOURCE.parent / "examples").is_dir() else _SOURCE / "examples"
rng = random.Random(20261016)

FIRST_NAMES = [
    "Ada", "Aksel", "Alba", "Ari", "Astrid", "Bea", "Benji", "Cai", "Cleo", "Dag", "Dina", "Eli",
    "Elin", "Ezra", "Fen", "Freya", "Gus", "Hali", "Ines", "Ivo", "Jun", "Kaia", "Kian", "Lio",
    "Lumi", "Mads", "Maren", "Milo", "Nell", "Nico", "Noor", "Oda", "Otto", "Pia", "Quin", "Rafi",
    "Rhea", "Sami", "Saga", "Tove", "Teo", "Una", "Vida", "Vik", "Wren", "Yara", "Zeno", "Zoe",
]

# Invented surnames: built from syllables so they read naturally but belong to nobody in particular.
SURNAME_PARTS_A = ["Ash", "Brin", "Cal", "Dun", "Ever", "Fern", "Gal", "Hollo", "Iver", "Kest", "Lark",
                   "Marro", "Nor", "Oak", "Pell", "Quil", "Raven", "Sel", "Thorn", "Umber", "Vell", "Wren"]
SURNAME_PARTS_B = ["brook", "dell", "fall", "gard", "holt", "mere", "more", "ridge", "stead", "vale", "wick", "by"]

LOCATIONS = ["Copenhagen", "Aarhus", "Stockholm", "Oslo", "Berlin", "Amsterdam", "Remote"]

# Fictional company: Halcyon Instruments. Department -> team -> (lead title, member titles, size).
ORG = {
    "Executive Office": {
        "Leadership": ("Chief Executive Officer", ["Chief Operating Officer", "Chief Financial Officer", "Executive Assistant"], 4),
    },
    "Product & Engineering": {
        "Platform": ("Engineering Manager", ["Senior Software Engineer", "Software Engineer", "Site Reliability Engineer"], 7),
        "Data & Insights": ("Head of Data", ["Data Engineer", "Analytics Engineer", "Data Analyst"], 6),
        "Product Design": ("Design Lead", ["Product Designer", "UX Researcher"], 4),
        "Quality": ("QA Lead", ["Test Engineer", "Automation Engineer"], 4),
    },
    "Customer & Sales": {
        "Nordics": ("Sales Director Nordics", ["Account Executive", "Sales Engineer"], 5),
        "DACH & Benelux": ("Sales Director Central Europe", ["Account Executive", "Partner Manager"], 5),
        "Customer Success": ("Head of Customer Success", ["Customer Success Manager", "Support Specialist"], 6),
    },
    "Operations": {
        "Supply Chain": ("Supply Chain Manager", ["Planner", "Buyer", "Logistics Coordinator"], 5),
        "Manufacturing": ("Plant Manager", ["Production Engineer", "Technician", "Shift Lead"], 7),
    },
    "People & Finance": {
        "People": ("Head of People", ["People Partner", "Recruiter", "Learning Specialist"], 4),
        "Finance": ("Finance Manager", ["Controller", "Accountant", "FP&A Analyst"], 5),
        "IT": ("IT Manager", ["Systems Administrator", "Service Desk Analyst"], 3),
    },
}


def unique_names(count):
    used = set()
    names = []
    while len(names) < count:
        first = rng.choice(FIRST_NAMES)
        last = rng.choice(SURNAME_PARTS_A) + rng.choice(SURNAME_PARTS_B)
        if (first, last) in used:
            continue
        used.add((first, last))
        names.append((first, last))
    return names


def random_start(earliest_year=2013):
    start = date(earliest_year, 1, 1)
    days = (date(2026, 6, 30) - start).days
    return start + timedelta(days=rng.randrange(days))


def org_rows():
    total = sum(size for teams in ORG.values() for (_, _, size) in teams.values())
    names = iter(unique_names(total))
    rows = []
    for department, teams in ORG.items():
        for team, (lead_title, member_titles, size) in teams.items():
            home = rng.choice(LOCATIONS[:-1])
            for i in range(size):
                first, last = next(names)
                title = lead_title if i == 0 else rng.choice(member_titles)
                location = home if rng.random() < 0.65 else rng.choice(LOCATIONS)
                fte = 1.0 if rng.random() < 0.85 else rng.choice([0.8, 0.6, 0.5])
                rows.append({
                    "Department": department,
                    "Team": team,
                    "Person": f"{first} {last}",
                    "Position": title,
                    "Email": f"{first}.{last}@example.com".lower(),
                    "Location": location,
                    "Start date": random_start(2012 if i == 0 else 2016).isoformat(),
                    "FTE": fte,
                })
    return rows


# Fictional vendor and application portfolio: Program -> Vendor -> Application.
VENDORS = {
    "Northbeam Data": ["Capture Suite", "Northbeam Analytics"],
    "Kestrel Software": ["Kestrel CRM", "Kestrel Field"],
    "Bluefin Cloud": ["Bluefin Storage", "Bluefin Backup"],
    "Larchwood Labs": ["Lab Hub", "Sample Tracker"],
    "Orbis Systems": ["Orbis ERP", "Orbis Payroll"],
    "Quarry Tech": ["DocVault", "eSign Desk"],
    "Saltmarsh Security": ["Identity Gate", "Threat Watch"],
}
PROGRAMS = ["Program Alder", "Program Birch", "Program Cedar", "Program Dune", "Program Elm"]


def portfolio_rows():
    rows = []
    for program in PROGRAMS:
        vendors = rng.sample(list(VENDORS), rng.randint(3, 5))
        for vendor in vendors:
            apps = rng.sample(VENDORS[vendor], rng.randint(1, len(VENDORS[vendor])))
            for app in apps:
                licences = rng.choice([5, 10, 15, 25, 40, 60, 80, 120])
                cost = round(licences * rng.uniform(600, 1600), -2)
                rows.append({"Program": program, "Vendor": vendor, "Application": app,
                             "Licences": licences, "Annual cost": int(cost)})
    # A few deliberate edge cases for demos: an unassigned vendor and a zero-cost pilot.
    rows.append({"Program": "Program Dune", "Vendor": "", "Application": "Shared Wiki", "Licences": 30, "Annual cost": 4200})
    rows.append({"Program": "Program Elm", "Vendor": "Quarry Tech", "Application": "eSign Pilot", "Licences": 5, "Annual cost": 0})
    return rows


def write(name, rows):
    OUT.mkdir(exist_ok=True)
    path = OUT / name
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {path} ({len(rows)} rows)")


if __name__ == "__main__":
    write("showcase-org.csv", org_rows())
    write("showcase-portfolio.csv", portfolio_rows())
