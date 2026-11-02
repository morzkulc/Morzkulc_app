"""
PDF „Polityka prywatności SKK Morzkulc” z tej samej treści co strona morzkulc.pl/polityka-prywatnosci
(site_www/pages/polityka-prywatnosci.html) — jedno źródło tekstu, PDF zawsze zgodny ze stroną.

Użycie: python scripts/build-privacy-pdf.py [DD.MM.RRRR]   (data wersji; domyślnie dziś)
Wynik:  site_www/dokumenty/polityka-prywatnosci.pdf  → https://morzkulc.pl/dokumenty/polityka-prywatnosci.pdf
Wymaga: pip install reportlab beautifulsoup4
"""
import datetime
import os
import re
import sys

from bs4 import BeautifulSoup, NavigableString
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "site_www", "pages", "polityka-prywatnosci.html")
OUT = os.path.join(ROOT, "site_www", "dokumenty", "polityka-prywatnosci.pdf")
FONTS = r"C:\Windows\Fonts"

pdfmetrics.registerFont(TTFont("Arial", os.path.join(FONTS, "arial.ttf")))
pdfmetrics.registerFont(TTFont("Arial-Bold", os.path.join(FONTS, "arialbd.ttf")))
pdfmetrics.registerFont(TTFont("Arial-Italic", os.path.join(FONTS, "ariali.ttf")))
pdfmetrics.registerFont(TTFont("Arial-BoldItalic", os.path.join(FONTS, "arialbi.ttf")))
pdfmetrics.registerFontFamily("Arial", normal="Arial", bold="Arial-Bold", italic="Arial-Italic", boldItalic="Arial-BoldItalic")

NAVY = "#0b3d5c"
S = {
    "h1": ParagraphStyle("h1", fontName="Arial-Bold", fontSize=18, leading=22, textColor=NAVY, spaceAfter=4),
    "meta": ParagraphStyle("meta", fontName="Arial", fontSize=9, leading=12, textColor="#555555", spaceAfter=10),
    "h2": ParagraphStyle("h2", fontName="Arial-Bold", fontSize=12.5, leading=16, textColor=NAVY, spaceBefore=10, spaceAfter=4),
    "h3": ParagraphStyle("h3", fontName="Arial-Bold", fontSize=10.5, leading=14, spaceBefore=6, spaceAfter=2),
    "p": ParagraphStyle("p", fontName="Arial", fontSize=10, leading=14, spaceAfter=5, alignment=TA_LEFT),
}


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(node):
    """Elementy w linii → znaczniki reportlab (<b>, <i>, <a>, <br/>)."""
    out = []
    for c in node.children:
        if isinstance(c, NavigableString):
            out.append(esc(re.sub(r"\s+", " ", str(c))))
        elif c.name in ("strong", "b"):
            out.append("<b>" + inline(c) + "</b>")
        elif c.name in ("em", "i"):
            out.append("<i>" + inline(c) + "</i>")
        elif c.name == "br":
            out.append("<br/>")
        elif c.name == "a":
            href = c.get("href", "")
            if href.startswith("/"):
                href = "https://morzkulc.pl" + href
            out.append('<a href="%s" color="%s">%s</a>' % (esc(href), NAVY, inline(c)))
        else:
            out.append(inline(c))
    return re.sub(r" {2,}", " ", "".join(out)).replace("<br/> ", "<br/>").strip()


def build(version):
    html = open(SRC, encoding="utf-8").read()
    main = BeautifulSoup(html, "html.parser").find("main")
    story = []
    for el in main.find_all(["h1", "h2", "h3", "p", "ul"], recursive=False):
        if el.name == "p" and "muted" in (el.get("class") or []):
            continue  # odnośnik do PDF na stronie — w samym PDF zbędny
        if el.name == "h1":
            story.append(Paragraph(inline(el) + " SKK Morzkulc", S["h1"]))
            story.append(Paragraph("Stowarzyszenie Klub Kajakowy Morzkulc · wersja z dnia " + version +
                                   " · aktualna treść: morzkulc.pl/polityka-prywatnosci", S["meta"]))
        elif el.name == "ul":
            items = [ListItem(Paragraph(inline(li), S["p"]), leftIndent=12) for li in el.find_all("li", recursive=False)]
            story.append(ListFlowable(items, bulletType="bullet", start="•", leftIndent=12, bulletFontName="Arial"))
            story.append(Spacer(1, 3))
        else:
            story.append(Paragraph(inline(el), S[el.name]))

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Arial", 8)
        canvas.setFillColor("#777777")
        canvas.drawString(20 * mm, 12 * mm, "Polityka prywatności SKK Morzkulc — wersja z dnia " + version)
        canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, "%d" % doc.page)
        canvas.restoreState()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm,
                            title="Polityka prywatności SKK Morzkulc", author="Stowarzyszenie Klub Kajakowy Morzkulc",
                            subject="Polityka prywatności, wersja z dnia " + version, lang="pl")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print("PDF:", OUT)


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().strftime("%d.%m.%Y"))
