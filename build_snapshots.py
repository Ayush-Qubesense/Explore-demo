# -*- coding: utf-8 -*-
"""
Generates ~40 'hollow' OPRS page snapshots that reuse the REAL Frest CSS/JS
copied from the QubesenseNextGenOPRSV2 app (SiteV3.master shell).
Output: Seach/pages/<id>.html  + Seach/index.html (launcher)
Run:    python build_snapshots.py
"""
import hashlib
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
PAGES_DIR = os.path.join(ROOT, "pages")
DATA_DIR = os.path.join(ROOT, "assets", "data")
os.makedirs(PAGES_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

# ---------------------------------------------------------------- menu model
# section -> (icon, [ (label, target_file) ])
MENU = [
    ("Operations", "menu-icon ti ti-activity", [
        ("Planner", "1750.html"), ("Labor Scheduler", "1600.html"),
        ("Utilization", "1686.html"), ("Activity Map", "1702.html"),
        ("Deployments / Arrivals", "1728.html"), ("Notifications", "1701.html"),
        ("Dispatch Agent", "1788.html"), ("Field Tech Tracker Report", "1794.html"),
    ]),
    ("Ticketing", "menu-icon ti ti-ticket", [
        ("Field Service", "1455.html"), ("Shipper", "2868.html"),
        ("Receiver", "2866.html"), ("Intercompany Shipper", "2870.html"),
        ("Intercompany Receiver", "2872.html"),
    ]),
    ("Accounting", "menu-icon ti ti-database-dollar", [
        ("Invoicing", "2809.html"), ("Dashboard", "1770.html"),
        ("Payroll", "1676.html"), ("Time Card Audit", "1699.html"),
        ("Expenses", "1674.html"),
    ]),
    ("Maintenance", "menu-icon bx bx-wrench", [
        ("Maintenance", "1783.html"), ("Maintenance Due List", "1789.html"),
        ("Predictive Maintenance", "1601.html"),
    ]),
    ("Reports", "menu-icon tf-icons bx bx-customize", [
        ("Check List Report 1", "1796.html"), ("Check List Report 2", "1799.html"),
        ("Check List Report 3", "1800.html"), ("Check List Report 4", "1801.html"),
        ("ERP Inventory Report", "1806.html"),
    ]),
    ("Safety", "menu-icon tf-icons bx bx-customize", [
        ("JSAs", "1685.html"), ("Incident Reports", "1769.html"),
        ("Gas Monitors", "1626.html"), ("General Certifications", "1590g.html"),
        ("Equipment Certifications", "1590e.html"),
    ]),
    ("Training", "menu-icon ti ti-traffic-cone", [
        ("Customer Certifications", "1590c.html"),
        ("General Certifications", "1590g.html"),
        ("Equipment Certifications", "1590e.html"),
    ]),
    ("Documents", "menu-icon bx bx-file", [
        ("Certificate Expiration Tracker", "1602.html"),
        ("Document Module Configuration", "1580.html"),
    ]),
    ("Resource Setup", "menu-icon bx bx-cog", [
        ("Account Managers Setup", "1708.html"), ("Operation Areas Setup", "1712.html"),
        ("Equipment / Trailer Master", "1363.html"), ("Vehicle / Truck Master", "1362.html"),
        ("Facilities Setup", "1614.html"), ("Customer Master", "1352.html"),
        ("Warehouse / Yard Address", "1354.html"),
    ]),
]

# ---------------------------------------------------------------- page model
# file -> dict(title, section, archetype, action, cols, search)
#
# `search` is natural-language text folded into the embedding (see SEARCH_PLAN.md 3.1).
# It exists because column headers alone lose to real queries: Payroll's column is
# "OT Hours", and the model does not reliably read that as "overtime". It is also the
# ONLY semantic signal for the planner/dashboard/map pages, which have no real columns.
# ------------------------------------------------------------- cache busting
# The three files below change on EVERY build (retuned `search` text -> new vectors ->
# new page-index.js; edited palette -> new js/css). They are served by a plain static
# host with no revving, so a browser will happily reuse yesterday's copy forever.
#
# That failure is silent and vicious: you edit `search=`, rebuild, reload, and see the
# OLD ranking -- so you conclude the edit did nothing and "fix" it again. It also means
# a demo laptop that has ever opened the site can show stale results on stage.
#
# So stamp each URL with a short hash of the file's own bytes. Content-addressed, not a
# timestamp: an unchanged file keeps its URL and stays cached, and only what actually
# changed is re-fetched.
def asset_v(relpath):
    """Stamp a STATIC source file (css/js) by its own bytes."""
    full = os.path.join(ROOT, relpath)
    try:
        with open(full, "rb") as f:
            return "?v=" + hashlib.sha1(f.read()).hexdigest()[:8]
    except FileNotFoundError:
        return ""


_index_v = None


def index_v():
    """Stamp page-index.js by its INPUTS, not its bytes.

    page-index.js does not exist yet when this runs -- build_snapshots.py emits the HTML
    that references it, and generate_embeddings.js writes it afterwards. Hashing the file
    on disk would therefore stamp the PREVIOUS build's index, which is exactly the stale
    cache this is meant to prevent (and it fails silently: rebuild twice, change something
    on the second, and the stamp still names the first).

    So hash what the index is derived from. page-index.js is a pure function of PAGES +
    DESCRIPTIONS (its vectors are a function of the embed text, which is a function of
    PAGES), so this changes exactly when the index does -- and, unlike a timestamp, does
    NOT churn all 41 HTML files on a no-op rebuild.
    """
    global _index_v
    if _index_v is None:
        payload = json.dumps({"pages": PAGES, "desc": DESCRIPTIONS},
                             sort_keys=True, default=str)
        _index_v = "?v=" + hashlib.sha1(payload.encode("utf-8")).hexdigest()[:8]
    return _index_v


def L(title, section, cols, archetype="list", action="New", search=""):
    return dict(title=title, section=section, archetype=archetype, action=action,
                cols=cols, search=search)

PAGES = {
    # Operations
    "1750":  dict(title="Planner", section="Operations", archetype="planner",
                  search="daily plan, schedule board, dispatch board, jobs for today, what is on today, assign work, home page"),
    "1600":  L("Labor Scheduler", "Operations", ["Employee","Role","Shift","Facility","Scheduled Date","Status"], action="New Shift",
               search="shift scheduling, roster, who works when, staffing, assign shifts, crew schedule, manpower planning, "
                      "move shift, change shift, reassign tech, edit worker schedule, morning afternoon shift"),
    "1686":  dict(title="Utilization", section="Operations", archetype="dashboard",
                  search="crew utilization, capacity, how busy are we, productivity, idle time, resource usage, billable hours, "
                         "utilization dashboard"),
    "1702":  dict(title="Activity Map", section="Operations", archetype="map",
                  search="live GPS, vehicle locations, map of units, where are my trucks, fleet tracking, real time positions, geofence"),
    "1728":  L("Deployments / Arrivals", "Operations", ["Vehicle","Job #","ETD","DEP","ETA","ARR","Status"], action="Refresh",
               search="who is late, delayed departures, missed departure, behind schedule, truck arrivals, departure times, on time performance, estimated arrival"),
    "1701":  L("Notifications", "Operations", ["Type","Message","Related Job","Created","Status"], action="Mark All Read",
               search="alerts, messages, unread, warnings, system notices, what happened"),
    "1788":  L("Dispatch Agent", "Operations", ["Agent","Job #","Customer","Assigned Tech","Priority","Status"], action="Auto Dispatch",
               search="auto dispatch, assign technician, job assignment, routing, who is assigned, send a tech"),
    "1794":  L("Field Tech Tracker Report", "Operations", ["Technician","Facility","Last Seen","Vehicle","On Job","Status"], action="Export",
               search="where are my technicians, last seen, tech location, field staff tracking, who is on site, crew whereabouts"),
    # Ticketing
    "1455":  L("Field Service", "Ticketing", ["Ticket #","Customer","Job Type","Lease / Well","Tech","Ticket Date","Status"], action="New Ticket",
               search="work orders, service tickets, jobs, well site work, technician tickets, lease work, field jobs"),
    "2868":  L("Shipper", "Ticketing", ["Shipment #","Customer","Origin","Destination","Ship Date","Status"], action="New Shipper",
               search="outbound shipments, sending goods, dispatch freight, bill of lading, ship out"),
    "2866":  L("Receiver", "Ticketing", ["Receipt #","Customer","Origin","Received By","Received Date","Status"], action="New Receiver",
               search="inbound shipments, receiving goods, deliveries in, goods receipt, what arrived, "
                      "receive shipments, receive inbound, record receipt, process receiver, receiver module, goods in"),
    "2870":  L("Intercompany Shipper", "Ticketing", ["Shipment #","From Co.","To Co.","Item","Ship Date","Status"], action="New Shipper",
               search="transfer between companies, outbound intercompany, internal transfer out, branch to branch shipment"),
    "2872":  L("Intercompany Receiver", "Ticketing", ["Receipt #","From Co.","To Co.","Item","Received Date","Status"], action="New Receiver",
               search="transfer between companies, inbound intercompany, internal transfer in, branch to branch receipt"),
    # Accounting
    "2809":  L("Invoicing", "Accounting", ["Invoice #","Customer","Job #","Invoice Date","Amount","Status"], action="New Invoice",
               search="invoices, billing, how much did we bill, accounts receivable, customer charges, unpaid, overdue invoices, revenue billed"),
    "1770":  dict(title="Accounting Dashboard", section="Accounting", archetype="dashboard",
                  search="revenue, financial overview, KPIs, money, profit, financial summary, how are we doing financially"),
    "1676":  L("Payroll", "Accounting", ["Employee","Pay Period","Reg Hours","OT Hours","Gross Pay","Status"], action="Run Payroll",
               search="overtime, wages, paychecks, gross pay, hours worked, pay period, employee compensation, salary, OT hours, "
                      "pay stubs, payslips, generate pay stubs, run payroll"),
    "1699":  L("Time Card Audit", "Accounting", ["Employee","Date","Clock In","Clock Out","Total Hours","Status"], action="Audit",
               search="overtime, clock in clock out, timesheets, hours discrepancy, attendance, time tracking, punch times"),
    "1674":  L("Expenses", "Accounting", ["Expense #","Employee","Category","Date","Amount","Status"], action="New Expense",
               search="reimbursements, spending, receipts, expense claims, costs, employee expenses"),
    # Maintenance
    "1783":  L("Maintenance", "Maintenance", ["Work Order","Asset","Type","Assigned","Due Date","Status"], action="New Work Order",
               # Deliberately does NOT repeat "maintenance": the name lane already pins this
               # page for the bare title (tier 0.98), and every extra "maintenance" token
               # here made 1783 outrank 1789 Maintenance Due List on ITS own queries --
               # measured, 1789 fell to 8.3% recall. Add vocabulary the neighbours lack.
               search="repairs, fix equipment, service asset, breakdown, maintenance work orders, broken truck, "
                      "work order list, open work orders, repair jobs, fix it"),
    "1789":  L("Maintenance Due List", "Maintenance", ["Asset","Service","Last Done","Due Date","Meter","Status"], action="Schedule",
               search="upcoming service, overdue maintenance, what needs servicing, preventive maintenance due, inspection due, service schedule"),
    "1601":  dict(title="Predictive Maintenance", section="Maintenance", archetype="dashboard",
                  search="failure prediction, breakdown risk, asset health, condition monitoring, anticipate failures, what will break"),
    # Reports
    "1796":  L("Check List Report 1", "Reports", ["Job #","Checklist","Technician","Completed","Score","Status"], action="Export",
               search="inspection checklist results, completed checklists, audit forms, compliance checks, job checklist scores"),
    "1799":  L("Check List Report 2", "Reports", ["Job #","Checklist","Technician","Completed","Score","Status"], action="Export",
               search="inspection checklist results, completed checklists, audit forms, compliance checks, job checklist scores"),
    "1800":  L("Check List Report 3", "Reports", ["Job #","Checklist","Technician","Completed","Score","Status"], action="Export",
               search="inspection checklist results, completed checklists, audit forms, compliance checks, job checklist scores"),
    "1801":  L("Check List Report 4", "Reports", ["Job #","Checklist","Technician","Completed","Score","Status"], action="Export",
               search="inspection checklist results, completed checklists, audit forms, compliance checks, job checklist scores"),
    "1806":  L("ERP Inventory Report", "Reports", ["SKU","Item","Warehouse","On Hand","Reorder Pt","Status"], action="Export",
               search="stock levels, on hand quantity, reorder, warehouse inventory, parts stock, supplies, what do we have in stock"),
    # Safety
    "1685":  L("JSAs", "Safety", ["JSA #","Task","Facility","Prepared By","Date","Status"], action="New JSA",
               search="job safety analysis, hazard assessment, safety forms, risk assessment, pre job safety, JSA"),
    "1769":  L("Incident Reports", "Safety", ["Incident #","Type","Facility","Reported By","Date","Severity"], action="New Incident",
               search="accidents, injuries, near miss, safety events, incidents, OSHA recordable, someone got hurt"),
    "1626":  L("Gas Monitors", "Safety", ["Monitor #","Model","Assigned To","Last Cal","Next Cal","Status"], action="New Monitor",
               search="gas detector, calibration due, H2S monitor, gas detection equipment, bump test, air monitoring"),
    "1590g": L("General Certifications", "Safety", ["Employee","Certification","Issued","Expires","Issuer","Status"], action="New Certification",
               search="expired certifications, expiring cards, OSHA, compliance, employee training records, credentials, tickets and licences"),
    "1590e": L("Equipment Certifications", "Safety", ["Equipment","Certification","Issued","Expires","Inspector","Status"], action="New Certification",
               search="equipment inspection certificates, expired equipment certs, asset compliance, API inspection, gear certification"),
    # Training
    "1590c": L("Customer Certifications", "Training", ["Customer","Certification","Issued","Expires","Owner","Status"], action="New Certification",
               search="customer specific training, site access requirements, customer compliance, customer credentials"),
    # Documents
    "1602":  L("Certificate Expiration Tracker", "Documents", ["Document","Owner","Category","Issued","Expires","Status"], action="Upload",
               search="expiring documents, expired paperwork, renewals, what expires soon, document expiry, out of date documents"),
    "1580":  L("Document Module Configuration", "Documents", ["Module","Category","Template","Required","Updated","Status"], action="New Config",
               search="document setup, templates, required documents, module configuration, paperwork rules"),
    # Resource Setup
    "1708":  L("Account Managers Setup", "Resource Setup", ["Name","Email","Region","Customers","Phone","Status"], action="New Manager",
               search="sales reps, account owners, who manages this customer, manager assignment"),
    "1712":  L("Operation Areas Setup", "Resource Setup", ["Area","Region","Facility","Supervisor","Wells","Status"], action="New Area",
               search="regions, territories, operating areas, area setup, field areas, basins"),
    "1363":  L("Equipment / Trailer Master", "Resource Setup", ["Unit #","Type","Make","Model","Facility","Status"], action="New Equipment",
               search="trailers, equipment list, asset register, units, gear, machinery"),
    "1362":  L("Vehicle / Truck Master", "Resource Setup", ["Unit #","Type","Make","Plate","Facility","Status"], action="New Vehicle",
               search="trucks, fleet list, vehicles, license plates, fleet register, cars"),
    "1614":  L("Facilities Setup", "Resource Setup", ["Facility","Type","City","State","Manager","Status"], action="New Facility",
               search="yards, locations, sites, offices, facility list, bases, depots"),
    "1352":  L("Customer Master", "Resource Setup", ["Customer #","Customer","Area","Account Mgr","Terms","Status"], action="New Customer",
               search="customers, clients, accounts, customer list, who we work for, client records"),
    "1354":  L("Warehouse / Yard Address", "Resource Setup", ["Warehouse","Address","City","State","Zip","Status"], action="New Warehouse",
               search="warehouse addresses, yard locations, storage sites, depot addresses"),
}

# ------------------------------------------------------- palette suggestions
# Shown in the command palette before the user types anything. See the v2 plan.
#
# Keyed on PAGES ids, NEVER on MENU labels: MENU labels are not unique ("General
# Certifications" sits under both Safety and Training) and disagree with PAGES
# (MENU says "Dashboard", PAGES says "Accounting Dashboard"). The palette hydrates
# titles from the index, so the id is the only safe key.
#
# These three deliberately span three sections -- the same choice the navbar's
# Shortcuts dropdown already made. A naive "first N pages" would be all Operations.
SHORTCUTS = ["1750", "1455", "2809"]  # Planner, Field Service, Invoicing

# (query, expected top-1 page id).
#
# generate_embeddings.js FAILS THE BUILD if an expectation doesn't hold -- in BOTH
# semantic and keyword mode. Keyword mode is not academic: it is what file:// runs and
# what the ~2.1s cold-model window on stage runs.
#
# Note "who is late", not "who's late". The apostrophe form resolves to Vehicle / Truck
# Master in keyword mode -- "late" is a substring of "plate"/"template"/"related", which
# produced a 4-way tie at MIN_SCORE broken by id order. The word-boundary fix in
# keywordScore() handles that, and the gate below stops it ever regressing silently.
EXAMPLES = [
    ("who is late", "1728"),
    ("overdue invoices", "2809"),   # also demos the deep-link filter chip
    ("expired certifications", "1590g"),
]

# ---------------------------------------------------------------- sample data
NAMES = ["Jenny Collier","Jon Towne","Pedro Hayes","Orlando Klein","Lynne Maggio","Barry Powlowski",
         "Brenda Roob","Carole Hirthe","Derek Gutkowski","Grace Bergstrom","Aaron Santiago","Dexter Bartoletti"]
CUSTOMERS = ["Hermann Group","Brekke-Jaskolski","Bergstrom-McClure","Auto-Lease Auto-Well","AAA Oil Co","Cormier LLC"]
FACILITIES = ["Dallas Operations","Newark Ops","Permian Yard","Midland Hub","Delaware Basin"]
CITIES = [("Dallas","TX"),("Midland","TX"),("Newark","NJ"),("Odessa","TX"),("Houston","TX")]
STATUSES = [("Active","success"),("Pending","warning"),("Complete","primary"),("Overdue","danger"),("In Progress","info"),("On Hold","secondary")]
TYPES = ["Field Service","Delivery","Backhaul","Clamping","Inspection","Install","Pull"]
DATES = ["Jul 14, 2026","Jul 13, 2026","Jul 12, 2026","Jul 10, 2026","Aug 01, 2026","Jun 28, 2026"]
TIMES = ["01:00 AM","03:10 AM","07:45 AM","08:05 AM","12:30 PM","05:30 PM"]

def cell(col, i):
    c = col.lower()
    words = c.replace("/", " ").replace("#", " ").split()
    st = STATUSES[i % len(STATUSES)]
    if "status" in c:
        return '<span class="badge bg-label-%s">%s</span>' % (st[1], st[0])
    if "severity" in c or "priority" in c:
        sev = [("High","danger"),("Medium","warning"),("Low","success")][i % 3]
        return '<span class="badge bg-label-%s">%s</span>' % (sev[1], sev[0])
    if any(k in c for k in ["date","issued","expires","last","next","due","completed","created","seen","period","done","cal"]):
        return DATES[i % len(DATES)]
    if any(w in ("etd","dep","eta","arr","in","out") for w in words):
        return TIMES[i % len(TIMES)]
    if any(k in c for k in ["amount","pay","gross","cost","price"]):
        return "$%s.%02d" % ((i+3)*417, (i*13) % 100)
    if any(k in c for k in ["hours","qty","on hand","wells","customers","reorder","meter","score","total"]):
        return str((i+2)*7 + i)
    if any(k in c for k in ["customer","co.","company","owner"]):
        return CUSTOMERS[i % len(CUSTOMERS)]
    if any(k in c for k in ["facility","warehouse","region","area","origin","destination"]):
        return FACILITIES[i % len(FACILITIES)]
    if any(k in c for k in ["name","tech","employee","manager","assigned","prepared","reported","supervisor","by","agent","inspector"]):
        return NAMES[i % len(NAMES)]
    if "city" in c:
        return CITIES[i % len(CITIES)][0]
    if "state" in c:
        return CITIES[i % len(CITIES)][1]
    if any(k in c for k in ["type","category","service","role","shift","checklist","module","terms","model","make"]):
        return TYPES[i % len(TYPES)]
    if any(k in c for k in ["#","no","id","sku","unit","invoice","ticket","job","monitor","order","incident","plate","zip"]):
        base = 50000 + i*137
        return "%s-%d" % (col.split()[0].upper().replace("/","")[:3] or "REC", base)
    if any(k in c for k in ["email"]):
        return NAMES[i % len(NAMES)].lower().replace(" ",".") + "@opsflo.com"
    if any(k in c for k in ["phone"]):
        return "(432) 555-0%03d" % (100 + i*7)
    if any(k in c for k in ["address","lease","well","item","message","document","template","certification","task"]):
        return ["HAYDEN 14-23-B","LEASE4324 Well R0712","1420 Industrial Rd","MLE Assembly Kit","OSHA 30 Card","API 5CT Inspection"][i % 6]
    return TYPES[i % len(TYPES)]

# ---------------------------------------------------------------- HTML pieces
def esc(s): return s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

def head(title, rel, extra_css=""):
    return """<!DOCTYPE html>
<html lang="en" class="light-style layout-menu-fixed layout-compact" dir="ltr" data-theme="theme-default" data-assets-path="{rel}assets/frest/assets/" data-template="horizontal-menu-template">
<head>
<meta charset="utf-8" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, minimum-scale=1.0, maximum-scale=1.0" />
<title>OpsFlo - {title}</title>
<link rel="shortcut icon" type="image/png" sizes="16x16" href="{rel}assets/images/Logo/opsflo/OpsFloIcon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=Rubik:ital,wght@0,300;0,400;0,500;0,600;0,700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="{rel}assets/frest/assets/vendor/fonts/boxicons.css" />
<link rel="stylesheet" href="{rel}assets/frest/assets/vendor/fonts/fontawesome.css" />
<link rel="stylesheet" href="{rel}assets/frest/assets/vendor/fonts/flag-icons.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css" />
<link rel="stylesheet" href="{rel}assets/frest/assets/vendor/css/rtl/core.css" class="template-customizer-core-css" />
<link rel="stylesheet" href="{rel}assets/frest/assets/vendor/css/rtl/theme-default.css" class="template-customizer-theme-css" />
<link rel="stylesheet" href="{rel}assets/frest/assets/css/demo.css" />
<link rel="stylesheet" href="{rel}assets/frest/assets/vendor/libs/perfect-scrollbar/perfect-scrollbar.css" />
<link rel="stylesheet" href="{rel}assets/frest/assets/vendor/libs/select2/select2.css" />
<link rel="stylesheet" href="{rel}assets/frest/assets/vendor/libs/flatpickr/flatpickr.css" />
<link href="{rel}assets/frest/assets/vendor/css/frest.css" rel="stylesheet" />
<link href="{rel}assets/css/OPRS/master.css" rel="stylesheet" />
<link href="{rel}assets/css/command-palette.css{v_css}" rel="stylesheet" />
{extra_css}
<script src="{rel}assets/frest/assets/vendor/js/helpers.js"></script>
<style>
  /* demo-only: keep horizontal submenus opening on hover for file:// snapshots */
  .menu-horizontal .menu-inner > .menu-item:hover > .menu-sub{{ display:block; }}
  .snap-hero-badge{{ font-size:.7rem; letter-spacing:.04em; }}
  .planner-count{{ display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; border-radius:50%; border:1.6px solid currentColor; font-weight:600; font-size:.8rem; flex-shrink:0; line-height:1; }}
</style>
</head>
<body>
<div class="layout-wrapper layout-navbar-full layout-horizontal layout-without-menu">
<div class="layout-container">
""".format(title=esc(title), rel=rel, extra_css=extra_css,
           v_css=asset_v("assets/css/command-palette.css"))

def navbar(rel, pfx="", up="../launcher.html", home="../index.html"):
    return """
  <nav class="layout-navbar navbar navbar-expand-xl align-items-center bg-navbar-theme" id="layout-navbar">
    <div class="container-fluid">
      <div class="navbar-brand app-brand demo d-none d-xl-flex py-0 me-4">
        <a href="{home}" class="app-brand-link gap-2">
          <span class="app-brand-logo"><img src="{rel}assets/images/Logo/OpsFloLogo.png" height="40" alt="OpsFlo" /></span>
        </a>
      </div>
      <div class="navbar-nav-right d-flex align-items-center" id="navbar-collapse">
        <ul class="navbar-nav flex-row align-items-center ms-auto">
          <li class="nav-item navbar-search-wrapper me-2 me-xl-0">
            <a class="nav-link" href="javascript:void(0);" title="Legend"><i class="bx bx-info-circle bx-sm"></i></a>
          </li>
          <!-- AI command palette. Mirrors the (currently d-none) Frest search slot at
               SiteV3.master:124 in the real app, so the port is a copy-paste. -->
          <li class="nav-item dropdown navbar-dropdown me-2 me-xl-0" id="cmdPalette">
            <a class="nav-link" href="javascript:void(0);" id="cmdPaletteToggle" title="Ask or search (Ctrl+K)">
              <i class="bx bx-search-alt bx-sm"></i>
            </a>
            <div class="dropdown-menu dropdown-menu-end p-0" id="cmdPaletteMenu">
              <div class="cmdp-head">
                <i class="bx bx-search-alt cmdp-head-ico"></i>
                <input type="text" class="form-control cmdp-input" id="cmdPaletteInput" autocomplete="off"
                       placeholder="Ask or search&hellip;" aria-label="Ask or search" />
                <button type="button" class="cmdp-mic" id="cmdPaletteMic" title="Search by voice" hidden>
                  <i class="bx bx-microphone"></i>
                </button>
                <kbd class="cmdp-kbd">Ctrl+K</kbd>
              </div>
              <div class="cmdp-results" id="cmdPaletteResults"></div>
              <div class="cmdp-foot">
                <span id="cmdPaletteStatus">Loading&hellip;</span>
                <span class="cmdp-hint"><kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate <kbd>&crarr;</kbd> open</span>
              </div>
            </div>
          </li>
          <li class="nav-item dropdown-style-switcher dropdown me-2 me-xl-0">
            <a class="nav-link dropdown-toggle hide-arrow" href="javascript:void(0);" data-bs-toggle="dropdown"><i class="bx bx-sun bx-sm" id="themeIcon"></i></a>
            <ul class="dropdown-menu dropdown-menu-end dropdown-styles">
              <li><a class="dropdown-item" href="javascript:void(0);" data-theme-choice="light"><span class="align-middle"><i class="bx bx-sun me-2"></i>Light</span></a></li>
              <li><a class="dropdown-item" href="javascript:void(0);" data-theme-choice="dark"><span class="align-middle"><i class="bx bx-moon me-2"></i>Dark</span></a></li>
              <li><a class="dropdown-item" href="javascript:void(0);" data-theme-choice="system"><span class="align-middle"><i class="bx bx-desktop me-2"></i>System</span></a></li>
            </ul>
          </li>
          <li class="nav-item dropdown-shortcuts navbar-dropdown dropdown me-2 me-xl-0">
            <a class="nav-link dropdown-toggle hide-arrow" href="javascript:void(0);" data-bs-toggle="dropdown"><i class="bx bx-grid-alt bx-sm"></i></a>
            <div class="dropdown-menu dropdown-menu-end py-0"><div class="dropdown-menu-header border-bottom"><div class="dropdown-header d-flex align-items-center py-3"><h5 class="text-body mb-0 me-auto">Shortcuts</h5></div></div>
              <a class="dropdown-item py-2" href="{home}"><i class="bx bx-calendar-check me-2 text-primary"></i>Planner</a>
              <a class="dropdown-item py-2" href="{pfx}1455.html"><i class="bx bx-check-shield me-2 text-primary"></i>Field Service</a>
              <a class="dropdown-item py-2" href="{pfx}2809.html"><i class="bx bx-receipt me-2 text-primary"></i>Invoicing</a>
            </div>
          </li>
          <li class="nav-item dropdown-notifications navbar-dropdown dropdown me-3 me-xl-2">
            <a class="nav-link dropdown-toggle hide-arrow" href="javascript:void(0);" data-bs-toggle="dropdown"><i class="bx bx-bell bx-sm"></i></a>
            <div class="dropdown-menu dropdown-menu-end py-0"><div class="dropdown-menu-header border-bottom"><div class="dropdown-header d-flex align-items-center py-3"><h5 class="text-body mb-0 me-auto">Notifications</h5></div></div>
              <a class="dropdown-item py-2" href="javascript:void(0);"><div class="fw-semibold">Job 00585 dispatch is late</div><small class="text-muted">DEP exceeded by 40 min</small></a>
            </div>
          </li>
          <li class="nav-item navbar-dropdown dropdown-user dropdown">
            <a class="nav-link dropdown-toggle hide-arrow" href="javascript:void(0);" data-bs-toggle="dropdown">
              <div class="avatar avatar-online"><img src="{rel}assets/frest/assets/img/avatars/1.jpg" alt class="rounded-circle" /></div>
            </a>
            <ul class="dropdown-menu dropdown-menu-end">
              <li><a class="dropdown-item" href="javascript:void(0);"><div class="d-flex"><div class="flex-shrink-0 me-3"><div class="avatar avatar-online"><img src="{rel}assets/frest/assets/img/avatars/1.jpg" alt class="rounded-circle" /></div></div><div class="flex-grow-1"><span class="fw-medium d-block lh-1">Michael Jenkins</span><small class="text-muted">OPRS@indoglobus.com</small></div></div></a></li>
              <li><div class="dropdown-divider"></div></li>
              <li><a class="dropdown-item" href="{up}"><i class="bx bx-grid-alt me-2"></i><span class="align-middle">All Snapshots</span></a></li>
              <li><a class="dropdown-item" href="javascript:void(0);"><i class="bx bx-power-off me-2"></i><span class="align-middle">Log Out</span></a></li>
            </ul>
          </li>
        </ul>
      </div>
    </div>
  </nav>
""".format(rel=rel, pfx=pfx, up=up, home=home)

def menu(active_section, pfx=""):
    items = []
    for sec, icon, subs in MENU:
        active = " active" if sec == active_section else ""
        sub_html = "".join(
            '<li class="menu-item"><a class="menu-link" href="%s%s"><i class="menu-icon tf-icons bx bx-shape-circle"></i><div>%s</div></a></li>' % (pfx, tgt, esc(lbl))
            for lbl, tgt in subs
        )
        items.append(
            '<li class="menu-item%s"><a href="javascript:void(0)" class="menu-link menu-toggle"><i class="%s"></i><div>%s</div></a><ul class="menu-sub">%s</ul></li>'
            % (active, icon, esc(sec), sub_html)
        )
    return """
      <div class="layout-page">
        <div class="content-wrapper">
          <aside id="layout-menu" class="layout-menu-horizontal menu-horizontal menu bg-menu-theme flex-grow-0">
            <div class="container-fluid d-flex h-100"><ul class="menu-inner">%s</ul></div>
          </aside>
""" % "".join(items)

def footer_scripts(rel):
    return """
        </div>
      </div>
    </div>
  </div>
  <div class="layout-overlay layout-menu-toggle"></div>
  <div class="drag-target"></div>
</div>
<script src="{rel}assets/frest/assets/vendor/libs/popper/popper.js"></script>
<script src="{rel}assets/frest/assets/vendor/js/bootstrap.js"></script>
<script src="{rel}assets/frest/assets/vendor/libs/perfect-scrollbar/perfect-scrollbar.js"></script>
<script src="{rel}assets/frest/assets/vendor/libs/hammer/hammer.js"></script>
<script src="{rel}assets/frest/assets/vendor/js/menu.js"></script>
<script src="{rel}assets/frest/assets/js/main.js"></script>
<script>
(function(){{
  // Lightweight, reliable Light/Dark switch for the static snapshots
  var core = document.querySelector('.template-customizer-core-css');
  var theme = document.querySelector('.template-customizer-theme-css');
  function setTheme(mode){{
    var dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark-style', dark);
    document.documentElement.classList.toggle('light-style', !dark);
    if(core)  core.setAttribute('href', core.getAttribute('href').replace(/core(-dark)?\\.css/, dark ? 'core-dark.css' : 'core.css'));
    if(theme) theme.setAttribute('href', theme.getAttribute('href').replace(/theme-default(-dark)?\\.css/, dark ? 'theme-default-dark.css' : 'theme-default.css'));
    var ic = document.getElementById('themeIcon'); if(ic) ic.className = 'bx bx-sm ' + (dark ? 'bx-moon' : 'bx-sun');
    try{{ localStorage.setItem('opsflo-theme', mode); }}catch(e){{}}
  }}
  document.querySelectorAll('[data-theme-choice]').forEach(function(el){{
    el.addEventListener('click', function(){{ setTheme(el.getAttribute('data-theme-choice')); }});
  }});
  try{{ setTheme(localStorage.getItem('opsflo-theme') || 'light'); }}catch(e){{ setTheme('light'); }}
}})();
</script>
<!-- ------------------------------------------------------ AI command palette -->
<!-- Site root for this page's depth: "" at the root, "../" inside pages/. The index
     ships root-relative URLs; this is the only per-page value the widget needs.
     In production this is "" and the index carries absolute URLs. -->
<script>window.__OPSFLO_SITE_ROOT__ = "{rel}";</script>
<script src="{rel}assets/data/page-index.js{v_idx}"></script>
<!-- Classic script on purpose: it must still run under file://, where ES modules are
     CORS-blocked. It pulls transformers.min.js (which IS an ES module) via a lazy
     dynamic import() and falls back to keyword search if that import fails. -->
<script src="{rel}assets/js/command-palette.js{v_js}"></script>
</body>
</html>
""".format(rel=rel,
           v_idx=index_v(),  # by inputs, not bytes -- the file does not exist yet
           v_js=asset_v("assets/js/command-palette.js"))

def page_header(title, section, action):
    return """
          <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
            <div>
              <div class="text-muted small mb-1"><i class="bx bx-home-alt"></i> {section} <i class="bx bx-chevron-right"></i> {title}</div>
              <h4 class="fw-bold mb-0">{title}</h4>
            </div>
            <button class="btn btn-primary"><i class="bx bx-plus me-1"></i>{action}</button>
          </div>
""".format(title=esc(title), section=esc(section), action=esc(action))

def filter_toolbar():
    return """
          <div class="card mb-3"><div class="card-body py-3">
            <div class="row g-3 align-items-end">
              <div class="col-md-3"><label class="form-label small text-muted mb-1">Facility</label><select class="form-select"><option>Dallas Operations</option><option>Newark Ops</option></select></div>
              <div class="col-md-3"><label class="form-label small text-muted mb-1">Status</label><select class="form-select"><option>All</option><option>Active</option><option>Pending</option></select></div>
              <div class="col-md-3"><label class="form-label small text-muted mb-1">Date</label><input type="text" class="form-control" value="Jul 14, 2026" /></div>
              <div class="col-md-3 d-flex gap-2">
                <input type="text" class="form-control" placeholder="Search..." />
                <button class="btn btn-outline-primary"><i class="bx bx-search"></i></button>
              </div>
            </div>
          </div></div>
"""

def list_content(p):
    cols = p["cols"]
    thead = "".join("<th>%s</th>" % esc(c) for c in cols)
    rows = ""
    for i in range(7):
        tds = "".join("<td>%s</td>" % cell(c, (i + j) % 7) for j, c in enumerate(cols))
        rows += "<tr>%s<td class=\"text-end\"><i class='bx bx-dots-vertical-rounded text-muted'></i></td></tr>" % tds
    return """
          {header}{toolbar}
          <div class="card">
            <div class="card-datatable table-responsive">
              <table class="table table-hover mb-0">
                <thead class="table-light"><tr>{thead}<th></th></tr></thead>
                <tbody>{rows}</tbody>
              </table>
            </div>
            <div class="d-flex justify-content-between align-items-center px-3 py-2 border-top">
              <span class="text-muted small">Showing 1 to 7 of 7 entries</span>
              <ul class="pagination pagination-sm mb-0">
                <li class="page-item disabled"><a class="page-link" href="#">&laquo;</a></li>
                <li class="page-item active"><a class="page-link" href="#">1</a></li>
                <li class="page-item"><a class="page-link" href="#">2</a></li>
                <li class="page-item"><a class="page-link" href="#">&raquo;</a></li>
              </ul>
            </div>
          </div>
""".format(header=page_header(p["title"], p["section"], p["action"]), toolbar=filter_toolbar(), thead=thead, rows=rows)

def stat_card(icon, color, value, label, trend):
    return """
            <div class="col-sm-6 col-xl-3">
              <div class="card"><div class="card-body">
                <div class="d-flex align-items-center justify-content-between mb-2">
                  <span class="badge bg-label-{color} rounded p-2"><i class="bx {icon} bx-sm"></i></span>
                  <span class="text-{trendc} small"><i class="bx bx-up-arrow-alt"></i>{trend}</span>
                </div>
                <h4 class="mb-0">{value}</h4>
                <small class="text-muted">{label}</small>
              </div></div>
            </div>""".format(icon=icon, color=color, value=value, label=esc(label), trend=trend, trendc="success")

def spark_svg(color):
    pts = "0,38 30,30 60,34 90,20 120,26 150,12 180,18 210,8"
    return ('<svg viewBox="0 0 210 44" preserveAspectRatio="none" style="width:100%;height:70px">'
            '<polyline fill="none" stroke="' + color + '" stroke-width="2.5" points="' + pts + '"/>'
            '<polyline fill="' + color + '22" stroke="none" points="' + pts + ' 210,44 0,44"/></svg>')

def dashboard_content(p):
    cards = (stat_card("bx-briefcase","primary","1,284","Active Jobs","12%")
             + stat_card("bx-time-five","warning","326","Overtime Hrs","4%")
             + stat_card("bx-dollar-circle","success","$1.2M","Revenue MTD","8%")
             + stat_card("bx-car","info","61","Vehicles Out","3%"))
    return """
          {header}
          <div class="row g-3 mb-3">{cards}</div>
          <div class="row g-3">
            <div class="col-lg-8"><div class="card"><div class="card-header d-flex justify-content-between"><h5 class="mb-0">Utilization Trend</h5><span class="badge bg-label-primary">Last 8 weeks</span></div><div class="card-body">{spark}</div></div></div>
            <div class="col-lg-4"><div class="card"><div class="card-header"><h5 class="mb-0">By Crew</h5></div><div class="card-body">
              <div class="d-flex justify-content-between mb-2"><span>Clamping</span><span class="fw-semibold">58%</span></div><div class="progress mb-3" style="height:6px"><div class="progress-bar bg-primary" style="width:58%"></div></div>
              <div class="d-flex justify-content-between mb-2"><span>Delivery</span><span class="fw-semibold">34%</span></div><div class="progress mb-3" style="height:6px"><div class="progress-bar bg-info" style="width:34%"></div></div>
              <div class="d-flex justify-content-between mb-2"><span>Backhaul</span><span class="fw-semibold">17%</span></div><div class="progress" style="height:6px"><div class="progress-bar bg-warning" style="width:17%"></div></div>
            </div></div></div>
          </div>
""".format(header=page_header(p["title"], p["section"], "Export"), cards=cards, spark=spark_svg("#7367f0"))

def map_content(p):
    units = "".join('<div class="d-flex align-items-center justify-content-between py-2 border-bottom"><span><i class="bx bxs-truck text-primary me-2"></i>Unit %s</span><span class="badge bg-label-%s">%s</span></div>' % (400+i, STATUSES[i%len(STATUSES)][1], STATUSES[i%len(STATUSES)][0]) for i in range(7))
    map_svg = ('<div style="position:relative;height:480px;border-radius:.5rem;overflow:hidden;'
               'background:linear-gradient(135deg,#e8eef5,#d5e0ec)">'
               '<svg width="100%" height="100%" style="position:absolute;inset:0">'
               '<path d="M0,120 L900,90" stroke="#b8c6d8" stroke-width="6" fill="none"/>'
               '<path d="M120,0 L200,480" stroke="#b8c6d8" stroke-width="6" fill="none"/>'
               '<path d="M0,300 L900,340" stroke="#b8c6d8" stroke-width="6" fill="none"/>'
               '<circle cx="200" cy="120" r="9" fill="#28c76f"/><circle cx="430" cy="250" r="9" fill="#ea5455"/>'
               '<circle cx="640" cy="180" r="9" fill="#ff9f43"/><circle cx="320" cy="360" r="9" fill="#7367f0"/></svg>'
               '<span class="badge bg-white text-dark shadow-sm" style="position:absolute;top:12px;left:12px">Live GPS · 61 units</span></div>')
    return """
          {header}
          <div class="row g-3">
            <div class="col-lg-8"><div class="card"><div class="card-body">{map}</div></div></div>
            <div class="col-lg-4"><div class="card"><div class="card-header"><h5 class="mb-0">Units</h5></div><div class="card-body pt-0">{units}</div></div></div>
          </div>
""".format(header=page_header(p["title"], p["section"], "Refresh"), map=map_svg, units=units)

# --------- planner archetype (uses oprs.planner.css + Frest components) -------
def planner_content():
    techs = [("Barry Powlowski","Technician - 3D"),("Brenda Roob","Technician"),("Carole Hirthe","Technician - 3D"),
             ("Carrie Kshlerin","Technicians"),("Charlene Ullrich","Technician - 3D"),("Dave Jast","Technician"),
             ("Derek Gutkowski","Technician - 3D"),("Dexter Bartoletti","Technician"),("Drew Schowalter","Technician - 3D"),
             ("Erica Sawayn","Technician"),("Grace Bergstrom","Technician - 3D"),("Gregory Senger","Technician")]
    tech_html = ""
    for n, r in techs:
        ini = "".join(w[0] for w in n.split())
        tech_html += ('<div class="col"><div class="d-flex align-items-center gap-2 p-1">'
                      '<span class="avatar avatar-sm"><span class="avatar-initial rounded-circle bg-label-secondary">%s</span></span>'
                      '<div class="min-w-0"><div class="fw-semibold text-truncate" style="font-size:.75rem">%s</div>'
                      '<div class="text-muted" style="font-size:.68rem">%s</div></div></div></div>') % (ini, n, r)
    tracker = [("402","#8a8fa0","","02:45 AM","03:10 AM","danger","","","06:00 AM"),
               ("403","#8fd6c4","99","","12:30 PM","danger","05:30 AM","success","07:00 AM"),
               ("406","#8a8fa0","","","","","","","12:30 AM"),
               ("407","#e0a25c","","05:08 AM","07:45 AM","danger","NOT DEP","danger","06:00 AM"),
               ("408","#e6a7c0","99","05:24 PM","","","10:15 AM","danger","08:00 AM"),
               ("409","#8a8fa0","","04:06 AM","","","","","07:00 AM"),
               ("410","#8a8fa0","","04:00 AM","","","","","07:00 AM")]
    trows = ""
    for v, dot, trip, etd, dep, depc, eta, etac, start in tracker:
        trows += ('<tr><td><span class="d-inline-block rounded-circle me-1" style="width:8px;height:8px;background:%s"></span><strong>%s</strong></td>'
                  '<td>%s</td><td>%s</td><td class="%s">%s</td><td class="%s">%s</td><td></td><td>%s</td></tr>') % (
                  dot, v, ('<span class="badge bg-info rounded-pill">%s%%</span>' % trip) if trip else "", etd,
                  "text-danger fw-bold" if depc else "", dep,
                  ("text-%s fw-bold" % etac) if etac else "", eta, start)
    jobs = [("00585","Field Service - Clamping - 12Hr","Ullrich - Cormier - Greenfelder - Hermann","HAYDEN 14-23-B 2803VH","MLE Install","Shift - 1, 01:00 AM EST","08:50 AM","danger","Jenny Collier","Technician - 3D",None),
            ("51065","Field Service - Clamping - 12Hr","Brekke - Jaskolski - Oberbrunner LLC","LEASE4324-Ravi Test Well4324R0712","Clamp Pull","Shift - 1, 01:00 AM EST",None,None,"Jon Towne","Technician - 3D",None),
            ("51065","Field Service - Clamping - 12Hr","Brekke - Jaskolski - Oberbrunner LLC","LEASE4324-Ravi Test Well4324R0712","MLE Install","Shift - 1, 01:00 AM EST",None,None,"Pedro Hayes","Technician",("406","Tech Truck")),
            ("51066","Field Service - Delivery - 12Hr","Bergstrom - McClure - Hegmann and Sons","Auto-Lease Auto-Well","Delivery Local","Shift - 1, 01:30 AM EST","08:05 AM","success","Orlando Klein","Technician - 3D",("424","Tech Time")),
            ("51085","Field Service - Delivery - 12Hr","Bergstrom - McClure - Hegmann and Sons","Auto-Lease Auto-Well","Backhaul Delaware","Shift - 1, 02:00 AM EST",None,None,"Lynne Maggio","Technician - 3D",("414","Tech Truck"))]
    jobs_html = ""
    for no, typ, cust, lease, task, shift, dep, depc, who, role, veh in jobs:
        ini = "".join(w[0] for w in who.split())
        depbadge = ('<div class="mt-1"><span class="badge bg-label-%s">DEP %s</span></div>' % (depc, dep)) if dep else ""
        vehhtml = ('<div class="d-flex align-items-center gap-2 text-muted"><i class="bx bxs-truck"></i><div class="text-end"><div class="fw-semibold small text-heading">%s</div><div style="font-size:.68rem">%s</div></div></div>' % (veh[0], veh[1])) if veh else ""
        jobs_html += """
              <div class="card mb-2"><div class="card-body py-3 position-relative">
                <div class="position-absolute" style="top:.6rem;right:.8rem"><i class="bx bx-message-rounded-dots text-muted me-2"></i><i class="bx bx-dots-vertical-rounded text-muted"></i></div>
                <div class="row g-2 align-items-center">
                  <div class="col-md-5 text-center">
                    <div class="fw-bold">{no}</div><div class="text-muted small">{typ}</div>
                    <div class="text-muted" style="font-size:.72rem">{cust}</div><div class="text-muted" style="font-size:.72rem">{lease}</div>{depbadge}
                  </div>
                  <div class="col-md-4 d-flex gap-2 align-items-start">
                    <input type="checkbox" class="form-check-input mt-1 flex-shrink-0" />
                    <div><div class="fw-bold">{task}</div><div class="text-muted small">{shift}</div></div>
                  </div>
                  <div class="col-md-3 d-flex flex-column align-items-end gap-2">
                    <div class="d-flex align-items-center gap-2"><span class="avatar avatar-sm"><span class="avatar-initial rounded-circle bg-label-primary">{ini}</span></span><div class="text-end"><div class="fw-semibold small">{who}</div><div class="text-muted" style="font-size:.68rem">{role}</div></div></div>
                    {vehhtml}
                  </div>
                </div>
              </div></div>""".format(no=no, typ=typ, cust=cust, lease=lease, depbadge=depbadge, task=task, shift=shift, ini=ini, who=who, role=role, vehhtml=vehhtml)

    return """
          <div class="row g-3">
            <div class="col-xl-5">
              <div class="card">
                <div class="card-body">
                  <div class="row g-2 mb-3">
                    <div class="col-4"><label class="form-label small text-muted mb-1">Availability</label><select class="form-select form-select-sm"><option>Available</option></select></div>
                    <div class="col-4"><label class="form-label small text-muted mb-1">Facility</label><select class="form-select form-select-sm"><option>Dallas Operations</option></select></div>
                    <div class="col-4"><label class="form-label small text-muted mb-1">Sort</label><select class="form-select form-select-sm"><option>Alphabetical</option></select></div>
                  </div>
                  <div class="d-flex align-items-center justify-content-center gap-3 mb-3">
                    <button class="btn btn-icon btn-sm btn-outline-secondary rounded-circle"><i class="bx bx-chevron-left"></i></button>
                    <strong>July 14, 26</strong>
                    <button class="btn btn-icon btn-sm btn-outline-secondary rounded-circle"><i class="bx bx-chevron-right"></i></button>
                  </div>
                  <div class="row g-2 mb-3">
                    <div class="col-4"><div class="border rounded d-flex align-items-center justify-content-center gap-1 py-2 px-1">
                      <i class="bx bx-hard-hat text-muted me-1" style="font-size:1.35rem"></i>
                      <span class="planner-count" style="color:#6b7280">29</span><span class="planner-count" style="color:#3f7fe0">15</span><span class="planner-count" style="color:#ea5455">0</span>
                    </div></div>
                    <div class="col-4"><div class="border rounded d-flex align-items-center justify-content-center gap-1 py-2 px-1">
                      <i class="bx bxs-truck text-muted me-1" style="font-size:1.35rem"></i>
                      <span class="planner-count" style="color:#6b7280">17</span><span class="planner-count" style="color:#3f7fe0">13</span><span class="planner-count" style="color:#ea5455">0</span>
                    </div></div>
                    <div class="col-4"><div class="border rounded d-flex align-items-center justify-content-center gap-1 py-2 px-1">
                      <i class="bx bx-wrench text-muted me-1" style="font-size:1.35rem"></i>
                      <span class="planner-count" style="color:#6b7280">1</span><span class="planner-count" style="color:#3f7fe0">3</span><span class="planner-count" style="color:#ea5455">0</span>
                    </div></div>
                  </div>
                  <div class="d-flex gap-2 mb-3 overflow-hidden align-items-center">
                    <span class="badge bg-dark">ALL</span><span class="badge bg-label-secondary">CDL Driver</span>
                    <span class="badge bg-label-secondary">Clamp Technician</span><span class="badge bg-label-secondary">Desander Technician</span>
                    <span class="badge bg-label-secondary">Field Service Manager</span><i class="bx bx-chevron-right text-muted"></i>
                  </div>
                  <div class="row row-cols-4 g-1 mb-2">{tech}</div>
                </div>
                <ul class="nav nav-tabs px-3"><li class="nav-item"><a class="nav-link active" href="#">Tracker</a></li><li class="nav-item"><a class="nav-link" href="#">Activity Map</a></li><li class="nav-item"><a class="nav-link" href="#">Resource Map</a></li></ul>
                <div class="d-flex m-3 mb-2" style="height:20px;border-radius:.375rem;overflow:hidden;font-size:.65rem;font-weight:700;color:#fff">
                  <span style="width:16.67%;background:#28c76f;display:flex;align-items:center;justify-content:center">16.67%</span>
                  <span style="width:8.33%;background:#ff9f43;display:flex;align-items:center;justify-content:center">8.33%</span>
                  <span style="width:58.33%;background:#5b6472;display:flex;align-items:center;justify-content:center">58.33%</span>
                  <span style="width:16.67%;background:#e07ea3;display:flex;align-items:center;justify-content:center">16.67%</span>
                </div>
                <div class="table-responsive px-3 pb-3"><table class="table table-sm mb-0" style="font-size:.75rem"><thead><tr class="text-muted"><th>Vehicle</th><th>Trip</th><th>ETD</th><th>DEP</th><th>ETA</th><th>ARR</th><th>Start</th></tr></thead><tbody>{trows}</tbody></table></div>
              </div>
            </div>
            <div class="col-xl-7">
              <div class="card mb-3"><div class="card-body pb-2">
                <div class="d-flex align-items-center mb-3">
                  <div class="d-flex align-items-center gap-2"><button class="btn btn-icon btn-sm btn-outline-secondary rounded-circle"><i class="bx bx-chevron-left"></i></button><strong>July 14, 26</strong><button class="btn btn-icon btn-sm btn-outline-secondary rounded-circle"><i class="bx bx-chevron-right"></i></button></div>
                  <button class="btn btn-primary btn-sm ms-auto">Submit</button>
                </div>
                <div class="row g-2 mb-3">
                  <div class="col"><label class="form-label small text-muted mb-1">Job Status</label><select class="form-select form-select-sm"><option>Job Incomplete</option></select></div>
                  <div class="col"><label class="form-label small text-muted mb-1">Area</label><select class="form-select form-select-sm"><option>Permian</option></select></div>
                  <div class="col"><label class="form-label small text-muted mb-1">Task Type</label><select class="form-select form-select-sm"><option>Field Service</option></select></div>
                  <div class="col"><label class="form-label small text-muted mb-1">Customer</label><select class="form-select form-select-sm"><option>AAA Oil Co</option></select></div>
                  <div class="col"><label class="form-label small text-muted mb-1">Account Mgr</label><select class="form-select form-select-sm"><option>Aaron Santiago</option></select></div>
                </div>
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <button class="btn btn-sm btn-label-success"><i class="bx bx-slider"></i> Auto Assign</button>
                  <button class="btn btn-sm btn-label-danger"><i class="bx bx-undo"></i> Undo</button>
                  <div class="btn-group btn-group-sm ms-auto"><button class="btn btn-dark">Today</button><button class="btn btn-outline-secondary">Tomorrow</button><button class="btn btn-outline-secondary">Week</button><button class="btn btn-outline-secondary">Month</button></div>
                </div>
              </div></div>
              <div class="d-flex align-items-center justify-content-between mb-2 px-1"><h5 class="mb-0">July 14, 2026</h5><span class="text-muted small">Equipment Remaining</span></div>
              {jobs}
              <div class="d-flex align-items-center gap-2 flex-wrap mt-3 pb-4">
                <button class="btn btn-sm btn-success"><i class="bx bx-plus"></i> Create</button>
                <button class="btn btn-sm btn-outline-secondary">Selected</button>
                <button class="btn btn-sm btn-label-primary">Activate</button>
                <button class="btn btn-sm btn-label-danger">Recall</button>
                <button class="btn btn-sm btn-label-warning">Warning</button>
                <div class="ms-auto d-flex gap-2"><button class="btn btn-sm btn-outline-secondary">Pick List</button><button class="btn btn-sm btn-outline-secondary">Summary</button></div>
              </div>
            </div>
          </div>
""".format(tech=tech_html, trows=trows, jobs=jobs_html)

# ---------------------------------------------------------------- assemble
def content_for(fid, p):
    a = p.get("archetype", "list")
    if a == "planner":
        return planner_content()
    if a == "dashboard":
        return dashboard_content(p)
    if a == "map":
        return map_content(p)
    return list_content(p)

def build_page(fid, p):
    rel = "../"
    extra = '<link rel="stylesheet" href="%sassets/css/OPRS/oprs.planner.css" />' % rel if p.get("archetype") == "planner" else ""
    html = (head(p["title"], rel, extra) + navbar(rel) + menu(p["section"])
            + '<div class="container-fluid flex-grow-1 container-p-y">'
            + content_for(fid, p)
            + '</div>' + footer_scripts(rel))
    with open(os.path.join(PAGES_DIR, fid + ".html"), "w", encoding="utf-8") as f:
        f.write(html)

# ---------------------------------------------------------------- descriptions
# One line per page, rendered under the title in the command palette.
#
# DISPLAY ONLY -- deliberately NOT part of embed_text(), so editing these can never
# move search ranking. That separation is the point: prose in a mean-pooled vector
# dilutes every other token (measured: five extra terms on 1789 cost it 67% -> 8%
# recall). Descriptions are for the reader; `search` is for the ranker.
#
# Regenerate a first draft with:  node generate_descriptions.js
# That writes eval/descriptions.json for REVIEW and never edits this file -- these
# strings ship, so a human reads them before they do.
#
# Kept as a flat dict rather than a desc= on every L(): 41 one-liners proofread far
# better as a block than threaded through multi-line PAGES entries.
DESCRIPTIONS = {
    "1352"  : "Manage customers by number, area, manager, terms, and status",
    "1354"  : "Maintain warehouse locations with address, city, state, zip, status",
    "1362"  : "Track vehicles by unit, type, make, plate, facility, status",
    "1363"  : "Record equipment and trailers by unit, type, make, model, facility, status",
    "1455"  : "Log field service tickets with customer, job type, lease, tech, date, status",
    "1580"  : "Configure document modules by category, template, requirement, update, and status",
    "1590c" : "Track customer certifications, issue and expiry dates, owner, and status",
    "1590e" : "Record equipment certifications with issue, expiry, inspector, and status",
    "1590g" : "Track employee certifications, issue dates, expirations, and status",
    "1600"  : "Schedule employees by role, shift, facility, and status",
    "1601"  : "View equipment health trends and upcoming maintenance predictions",
    "1602"  : "Monitor document certificates, owners, categories, and expiration status",
    "1614"  : "Configure facility details, type, location, manager, and status",
    "1626"  : "Track gas monitors, models, assignments, calibrations, and status",
    "1674"  : "Record expenses by employee, category, date, amount, and status",
    "1676"  : "Process payroll with employee hours, pay period, and gross pay",
    "1685"  : "Review JSA records by task, facility, and status",
    "1686"  : "Monitor overall resource utilization across operations",
    "1699"  : "Audit employee time cards by date and status",
    "1701"  : "View notifications by type, related job, and status",
    "1702"  : "Explore field activity locations on interactive map",
    "1708"  : "Configure account manager profiles with contact and region details",
    "1712"  : "Define operation areas with facilities, supervisors, and well counts",
    "1728"  : "Track vehicle deployments and arrivals by job and schedule",
    "1750"  : "Plan and organize upcoming operations tasks",
    "1769"  : "Review incident reports by type, facility, and severity",
    "1770"  : "Monitor key accounting metrics and financial performance",
    "1783"  : "Track maintenance work orders by asset, type, and due date",
    "1788"  : "Assign dispatch agents to jobs with priority and status",
    "1789"  : "View upcoming maintenance services by asset and due date",
    "1794"  : "Track field technicians' locations, vehicles, and job status",
    "1796"  : "Review checklist completions, scores, and status per job",
    "1799"  : "Review checklist results by job, technician, and score",
    "1800"  : "Analyze checklist completion and scores per job",
    "1801"  : "Track checklist status and scores across jobs",
    "1806"  : "Monitor inventory levels by SKU, warehouse, and reorder point",
    "2809"  : "Generate and track invoices by customer, job, and date",
    "2866"  : "Record received shipments by receipt, customer, and date",
    "2868"  : "Create shipment orders by customer, origin, and destination",
    "2870"  : "Manage intercompany shipments by company, item, and ship date",
    "2872"  : "Track intercompany receipts by source, destination, item, and status",
}

# Normalise every entry BEFORE building anything: index_v() fingerprints PAGES, so a
# half-mutated dict would hash differently depending on which page was being built.
for fid, p in PAGES.items():
    p.setdefault("action", "New"); p.setdefault("cols", ["Name","Type","Date","Status"])

for fid, p in PAGES.items():
    build_page(fid, p)

# ---------------------------------------------------------------- launcher index
def launcher():
    cards = ""
    id_by_file = {}
    for fid, p in PAGES.items():
        id_by_file["%s.html" % fid] = (fid, p["title"])
    for sec, icon, subs in MENU:
        links = ""
        seen = set()
        for lbl, tgt in subs:
            if tgt in seen: continue
            seen.add(tgt)
            fid = tgt.replace(".html", "")
            exists = os.path.exists(os.path.join(PAGES_DIR, fid + ".html"))
            if not exists: continue
            links += ('<a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" href="pages/%s">'
                      '<span>%s</span><span class="badge bg-label-secondary">%s</span></a>') % (tgt, esc(lbl), fid)
        cards += """
      <div class="col-md-6 col-xl-4">
        <div class="card h-100"><div class="card-header d-flex align-items-center gap-2"><i class="%s"></i><h5 class="mb-0">%s</h5></div>
          <div class="list-group list-group-flush">%s</div></div>
      </div>""" % (icon, esc(sec), links)
    total = len(PAGES)
    html = (head("Snapshots", "", "") + navbar("", "pages/", "launcher.html", "index.html") + menu("Operations", "pages/")
            + '<div class="container-fluid flex-grow-1 container-p-y">'
            + '<div class="d-flex flex-wrap justify-content-between align-items-center mb-3"><div>'
            + '<h4 class="fw-bold mb-1">OpsFlo — Page Snapshots</h4>'
            + '<p class="text-muted mb-0">%d hollow page snapshots rendered with the real Frest / OPRS CSS. Click any page to open it.</p></div>' % total
            + '<a class="btn btn-primary" href="index.html"><i class="bx bx-calendar-check me-1"></i>Open Planner</a></div>'
            + '<div class="row g-3">' + cards + '</div>'
            + '</div>' + footer_scripts(""))
    with open(os.path.join(ROOT, "launcher.html"), "w", encoding="utf-8") as f:
        f.write(html)

def build_landing():
    # Root index.html lands on the Planner, exactly like the real app (home = 1750)
    rel = ""
    extra = '<link rel="stylesheet" href="assets/css/OPRS/oprs.planner.css" />'
    html = (head("Planner", rel, extra) + navbar(rel, "pages/", "launcher.html", "index.html") + menu("Operations", "pages/")
            + '<div class="container-fluid flex-grow-1 container-p-y">'
            + planner_content()
            + '</div>' + footer_scripts(rel))
    with open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)

# ------------------------------------------------- command-palette search index
# Emits assets/data/pages.json -> consumed by `node generate_embeddings.js`, which
# adds the vectors and writes assets/data/page-index.js. See SEARCH_PLAN.md 2 & 8.3:
# this file is the portability seam. Production replaces THIS producer (feature docs +
# per-user session filter) and reuses the embedder and the widget unchanged.

def embed_text(p):
    parts = [p["title"], p["section"]]
    # Only real column headers carry signal. The planner/dashboard/map archetypes get a
    # placeholder ["Name","Type","Date","Status"] from the setdefault below, which would
    # be pure noise in an embedding -- they rely on `search` instead.
    if p.get("archetype", "list") == "list":
        parts.append(", ".join(p["cols"]))
    if p.get("search"):
        parts.append(p["search"])
    return ". ".join(x for x in parts if x)

def emit_pages_json():
    rows = []
    for fid, p in PAGES.items():
        rows.append(dict(
            id=fid,
            title=p["title"],
            section=p["section"],
            # Root-relative URL. The widget NEVER builds a URL from an id -- it only
            # prepends window.__OPSFLO_SITE_ROOT__ (emitted per page depth by
            # footer_scripts). Production ships absolute URLs and an empty site root.
            url="pages/%s.html" % fid,
            text=embed_text(p),
            # `desc` is DISPLAY ONLY -- it is deliberately absent from embed_text(). It
            # renders under the title in the palette; it must never reach a vector.
            # Adding prose to the embedded text dilutes every other token under mean
            # pooling: measured, five extra terms on 1789 dropped its recall 67% -> 8%.
            # If you ever want desc embedded, put it in embed_text() and RE-RUN
            # `node generate_eval.js --score-only` before believing it helped.
            desc=DESCRIPTIONS.get(fid, ""),
            # Real column headers only. The planner/dashboard/map archetypes get a
            # placeholder ["Name","Type","Date","Status"] from the setdefault below,
            # which describes nothing -- same carve-out embed_text() makes.
            cols=(p["cols"] if p.get("archetype", "list") == "list" else []),
            archetype=p.get("archetype", "list"),
        ))
    rows.sort(key=lambda r: r["id"])
    path = os.path.join(DATA_DIR, "pages.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=1, ensure_ascii=False)
    missing = [r["id"] for r in rows if not r["text"].strip()]
    if missing:
        raise SystemExit("embed text empty for: %s" % ", ".join(missing))
    # A page with no description renders a blank line under its title in the palette --
    # visible, on stage, on the most-looked-at surface. Fail the build instead.
    nodesc = [r["id"] for r in rows if not r["desc"].strip()]
    if nodesc:
        raise SystemExit(
            "DESCRIPTIONS missing for: %s\n"
            "Add a line to DESCRIPTIONS, or regenerate a draft with: node generate_descriptions.js"
            % ", ".join(nodesc))
    return len(rows)

def emit_suggestions_json():
    # Sibling to pages.json, NOT folded into it: pages.json's flat-array shape is the
    # contract that lets generate_embeddings.js port to production unchanged.
    for fid in SHORTCUTS:
        if fid not in PAGES:
            raise SystemExit("SHORTCUTS references unknown page id: %s" % fid)
    for q, fid in EXAMPLES:
        if fid not in PAGES:
            raise SystemExit("EXAMPLES expects unknown page id: %s (query %r)" % (fid, q))
    data = dict(
        defaults=list(SHORTCUTS),
        examples=[dict(q=q, expect=fid) for q, fid in EXAMPLES],
    )
    path = os.path.join(DATA_DIR, "suggestions.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    return len(data["defaults"]), len(data["examples"])

launcher()
build_landing()
n_idx = emit_pages_json()
n_def, n_ex = emit_suggestions_json()
print("Generated %d page snapshots + launcher index.html" % len(PAGES))
print("Wrote assets/data/pages.json (%d entries)" % n_idx)
print("Wrote assets/data/suggestions.json (%d defaults, %d examples)" % (n_def, n_ex))
print("Now run: node generate_embeddings.js   (it verifies the examples and fails on a bad one)")
print("Pages:", ", ".join(sorted(PAGES.keys())))
