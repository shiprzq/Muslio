#!/usr/bin/env python3
"""
Build Muslio's offline knowledge base into ../data:

  data/quran/meta.json          114-surah directory
  data/quran/ar/<n>.json        Uthmani Arabic per surah (array of ayahs)
  data/quran/en/<n>.json        Saheeh International per surah
  data/hadith/<book>.json       Kutub al-Sittah + Nawawi 40 + Qudsi 40
                                (English + voweled Arabic + grades)

Raw downloads are cached in data/raw and can be deleted after building.
"""
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT_QURAN = os.path.join(ROOT, "data", "quran")
OUT_HADITH = os.path.join(ROOT, "data", "hadith")
for d in (RAW, OUT_QURAN, OUT_HADITH, os.path.join(OUT_QURAN, "ar"),
          os.path.join(OUT_QURAN, "en")):
    os.makedirs(d, exist_ok=True)

HADITH_BASE = "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/{}.min.json"
QURAN_AR = "https://api.alquran.cloud/v1/quran/quran-uthmani"
QURAN_EN = "https://api.alquran.cloud/v1/quran/en.sahih"

BOOKS = ["bukhari", "muslim", "abudawud", "tirmidhi", "nasai", "ibnmajah",
         "malik", "nawawi", "qudsi", "dehlawi"]

BOOK_META = {
    "bukhari":   ("Sahih al-Bukhari", "الجامع المسند الصحيح", "Imam Muhammad ibn Isma'il al-Bukhari (d. 256 AH)", 846, "Sahih (authentic throughout)"),
    "muslim":    ("Sahih Muslim", "المسند الصحيح", "Imam Muslim ibn al-Hajjaj al-Naysaburi (d. 261 AH)", 875, "Sahih (authentic throughout)"),
    "abudawud":  ("Sunan Abi Dawud", "سنن أبي داود", "Imam Abu Dawud al-Sijistani (d. 275 AH)", 889, "Grades vary; many sahih and hasan"),
    "tirmidhi":  ("Jami' al-Tirmidhi", "الجامع الكبير", "Imam Muhammad ibn 'Isa al-Tirmidhi (d. 279 AH)", 892, "Includes sahih, hasan and da'if, each graded"),
    "nasai":     ("Sunan an-Nasa'i", "المجتبى من السنن", "Imam Ahmad ibn Shu'ayb an-Nasa'i (d. 303 AH)", 915, "Mostly sahih and hasan, graded in modern editions"),
    "ibnmajah":  ("Sunan Ibn Majah", "سنن ابن ماجه", "Imam Muhammad ibn Yazid Ibn Majah al-Qazwini (d. 273 AH)", 887, "Grades vary; includes some da'if narrations"),
    "malik":     ("Muwatta Malik", "موطأ الإمام مالك", "Imam Malik ibn Anas (d. 179 AH)", 795, "Includes marfu', mawquf and mursal reports; grading varies"),
    "nawawi":    ("Forty Hadith of an-Nawawi", "الأربعون النووية", "Imam Yahya ibn Sharaf an-Nawawi (d. 676 AH)", 1277, "Core hadiths chosen as pillars of the religion"),
    "qudsi":     ("Forty Hadith Qudsi", "الأربعون القدسية", "Collected from Sahih and Sunan sources", None, "Sacred hadiths (hadith qudsi)"),
    "dehlawi":   ("Forty Hadith of Shah Waliullah Dehlawi", "أربعون حديثًا لشاه ولي الله الدهلوي", "Shah Waliullah al-Dehlawi (d. 1176 AH)", 1762, "A concise teaching collection; verify individual source notes"),
}


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 100:
        return dest
    print("  downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 MuslioBuilder"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    with open(dest, "wb") as f:
        f.write(data)
    return dest


CANONICAL_NAMES = [
    "Al-Fatihah", "Al-Baqarah", "Aal-E-Imran", "An-Nisa", "Al-Ma'idah",
    "Al-An'am", "Al-A'raf", "Al-Anfal", "At-Tawbah", "Yunus",
    "Hud", "Yusuf", "Ar-Ra'd", "Ibrahim", "Al-Hijr",
    "An-Nahl", "Al-Isra", "Al-Kahf", "Maryam", "Ta-Ha",
    "Al-Anbiya", "Al-Hajj", "Al-Mu'minun", "An-Nur", "Al-Furqan",
    "Ash-Shu'ara", "An-Naml", "Al-Qasas", "Al-Ankabut", "Ar-Rum",
    "Luqman", "As-Sajdah", "Al-Ahzab", "Saba", "Fatir",
    "Ya-Sin", "As-Saffat", "Sad", "Az-Zumar", "Ghafir",
    "Fussilat", "Ash-Shura", "Az-Zukhruf", "Ad-Dukhan", "Al-Jathiyah",
    "Al-Ahqaf", "Muhammad", "Al-Fath", "Al-Hujurat", "Qaf",
    "Adh-Dhariyat", "At-Tur", "An-Najm", "Al-Qamar", "Ar-Rahman",
    "Al-Waqi'ah", "Al-Hadid", "Al-Mujadila", "Al-Hashr", "Al-Mumtahanah",
    "As-Saff", "Al-Jumu'ah", "Al-Munafiqun", "At-Taghabun", "At-Talaq",
    "At-Tahrim", "Al-Mulk", "Al-Qalam", "Al-Haqqah", "Al-Ma'arij",
    "Nuh", "Al-Jinn", "Al-Muzzammil", "Al-Muddaththir", "Al-Qiyamah",
    "Al-Insan", "Al-Mursalat", "An-Naba", "An-Nazi'at", "Abasa",
    "At-Takwir", "Al-Infitar", "Al-Mutaffifin", "Al-Inshiqaq", "Al-Buruj",
    "At-Tariq", "Al-A'la", "Al-Ghashiyah", "Al-Fajr", "Al-Balad",
    "Ash-Shams", "Al-Layl", "Ad-Duha", "Ash-Sharh", "At-Tin",
    "Al-Alaq", "Al-Qadr", "Al-Bayyinah", "Az-Zalzalah", "Al-Adiyat",
    "Al-Qari'ah", "At-Takathur", "Al-Asr", "Al-Humazah", "Al-Fil",
    "Quraysh", "Al-Ma'un", "Al-Kawthar", "Al-Kafirun", "An-Nasr",
    "Al-Masad", "Al-Ikhlas", "Al-Falaq", "An-Nas",
]


def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s or "").replace(" ", " ").strip()


def build_quran():
    print("Building Quran data")
    ar = json.load(open(fetch(QURAN_AR, os.path.join(RAW, "quran_ar.json")), encoding="utf-8"))["data"]["surahs"]
    en = json.load(open(fetch(QURAN_EN, os.path.join(RAW, "quran_en_sahih.json")), encoding="utf-8"))["data"]["surahs"]
    meta = []
    for sa, se in zip(ar, en):
        n = sa["number"]
        ar_ayahs = [a["text"].lstrip("﻿").strip() for a in sa["ayahs"]]
        en_ayahs = [strip_tags(a["text"]) for a in se["ayahs"]]
        assert len(ar_ayahs) == len(en_ayahs), n
        meta.append({
            "n": n,
            "ar": sa["name"].replace("سُورَةُ ", "").strip(),
            "en": CANONICAL_NAMES[n - 1],
            "tr": se["englishNameTranslation"],
            "type": sa["revelationType"],
            "ay": len(ar_ayahs),
        })
        json.dump(ar_ayahs, open(os.path.join(OUT_QURAN, "ar", f"{n}.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        json.dump(en_ayahs, open(os.path.join(OUT_QURAN, "en", f"{n}.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump(meta, open(os.path.join(OUT_QURAN, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"  {len(meta)} surahs, {sum(m['ay'] for m in meta)} ayahs")


def build_hadith():
    print("Building hadith data")
    index = []
    for book in BOOKS:
        eng_path = fetch(HADITH_BASE.format(f"eng-{book}"), os.path.join(RAW, f"eng-{book}.json"))
        ara_path = fetch(HADITH_BASE.format(f"ara-{book}"), os.path.join(RAW, f"ara-{book}.json"))
        eng = json.load(open(eng_path, encoding="utf-8"))
        ara = json.load(open(ara_path, encoding="utf-8"))
        ara_map = {h["hadithnumber"]: h["text"] for h in ara["hadiths"]}

        out = []
        for h in eng["hadiths"]:
            grades = []
            for g in h.get("grades") or []:
                grade = strip_tags(g.get("grade", ""))
                if grade and grade not in grades:
                    grades.append(grade)
            ref = h.get("reference") or {}
            n = h["hadithnumber"]
            out.append({
                "n": n,
                "b": ref.get("book"),
                "h": ref.get("hadith"),
                "g": grades or None,
                "en": strip_tags(h["text"]),
                "ar": ara_map.get(n, "").strip(),
            })
        title, title_ar, author, died, grading = BOOK_META[book]
        sections = eng.get("metadata", {}).get("sections", {})
        doc = {
            "id": book,
            "title": title,
            "titleAr": title_ar,
            "author": author,
            "died": died,
            "grading": grading,
            "count": len(out),
            "sections": {str(k): v for k, v in sections.items() if v},
            "hadiths": out,
        }
        with open(os.path.join(OUT_HADITH, f"{book}.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        index.append({"id": book, "title": title, "titleAr": title_ar,
                      "author": author, "died": died, "grading": grading,
                      "count": len(out)})
        print(f"  {title}: {len(out)} hadiths")
    json.dump(index, open(os.path.join(OUT_HADITH, "index.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)


def build_search_catalog():
    """English-only compact catalog for fast cross-collection search."""
    print("Building hadith search catalog")
    docs = []
    for book in BOOKS:
        doc = json.load(open(os.path.join(OUT_HADITH, f"{book}.json"), encoding="utf-8"))
        for h in doc["hadiths"]:
            docs.append({"c": book, "n": h["n"], "b": h["b"], "h": h["h"],
                         "g": h["g"], "t": h["en"]})
    with open(os.path.join(OUT_HADITH, "search.json"), "w", encoding="utf-8") as f:
        json.dump(docs, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  {len(docs)} searchable narrations")


if __name__ == "__main__":
    build_quran()
    build_hadith()
    build_search_catalog()
    print("Done")
