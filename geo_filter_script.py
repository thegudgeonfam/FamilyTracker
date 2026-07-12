"""
Toronto Licensed Child Care Centres -- proximity shortlist builder
====================================================================
Run this once you have normal internet access (this script was designed
under a sandboxed session where the Toronto Open Data CKAN "datastore_*"
endpoints returned empty responses through the fetch tool available at the
time -- likely a proxy/allowlist quirk, not a dead API. "package_show"
worked fine and confirmed the dataset below is live and updated daily).

Dataset: City of Toronto Open Data -- "Licensed Child Care Centres"
Package: licensed-child-care-centres (id 059d37c6-d88b-42fb-b230-ec6a5ec74c24)
Resource (WGS84 lat/long CSV): 74eb5418-42c8-49d3-a62f-69941f0161f3
Refresh rate: Daily. ~1,090 records. Fields include address, ward,
capacity by age group (infant/toddler/preschool/kindergarten/school age),
auspice, and lat/long.

Usage:
    pip install requests pandas
    python geo_filter_script.py
"""
import requests
import pandas as pd
import math

BASE = "https://ckan0.cf.opendata.inter.prod-toronto.ca"
RESOURCE_ID = "74eb5418-42c8-49d3-a62f-69941f0161f3"

# Lansdowne Ave & Dupont St, Toronto (approx.)
HOME_LAT, HOME_LON = 43.6636, -79.4478
RADIUS_KM = 5.0  # ~20 min by transit/car; widen if the shortlist comes up thin

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

def fetch_all_records():
    """Pull the full datastore table via paginated datastore_search."""
    records = []
    offset = 0
    limit = 500
    while True:
        r = requests.get(
            f"{BASE}/api/3/action/datastore_search",
            params={"resource_id": RESOURCE_ID, "limit": limit, "offset": offset},
            timeout=30,
        )
        r.raise_for_status()
        result = r.json()["result"]
        batch = result["records"]
        records.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return records

def main():
    records = fetch_all_records()
    df = pd.DataFrame(records)
    print("Columns available:", list(df.columns))

    # Column names may vary slightly release to release -- adjust if the
    # printed column list above differs.
    lat_col = next(c for c in df.columns if c.lower() in ("lat_wgs84", "latitude", "lat"))
    lon_col = next(c for c in df.columns if c.lower() in ("long_wgs84", "longitude", "lon", "lng"))

    df[lat_col] = pd.to_numeric(df[lat_col], errors="coerce")
    df[lon_col] = pd.to_numeric(df[lon_col], errors="coerce")
    df = df.dropna(subset=[lat_col, lon_col])

    df["distance_km"] = df.apply(
        lambda row: haversine_km(HOME_LAT, HOME_LON, row[lat_col], row[lon_col]), axis=1
    )

    shortlist = df[df["distance_km"] <= RADIUS_KM].copy()

    # Try to filter to centres with an infant program if a capacity column exists
    infant_cols = [c for c in df.columns if "infant" in c.lower()]
    if infant_cols:
        col = infant_cols[0]
        shortlist[col] = pd.to_numeric(shortlist[col], errors="coerce").fillna(0)
        shortlist = shortlist[shortlist[col] > 0]

    shortlist = shortlist.sort_values("distance_km")
    out_cols = [c for c in shortlist.columns if c not in (lat_col, lon_col)] + [lat_col, lon_col, "distance_km"]
    shortlist[out_cols].to_csv("lansdowne_dupont_shortlist.csv", index=False)
    print(f"Wrote {len(shortlist)} centres within {RADIUS_KM} km to lansdowne_dupont_shortlist.csv")

if __name__ == "__main__":
    main()
