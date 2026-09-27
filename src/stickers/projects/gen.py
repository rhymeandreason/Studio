"""Generate the project sticker SVGs in this folder.

    python3 src/stickers/projects/gen.py

Every sticker is drawn the same way: a first pass of its silhouette in paper
white with a thick stroke (the die-cut border), then washi <pattern> fills and
ink details on top. The fox stickers share one head (fox(); ears, fur, eyes and
props vary).

This only rewrites the masters. To use one, copy it into a project folder as
its icon, e.g.
    cp src/stickers/projects/studio.svg ~/Projects/Studio/.studio-icon.svg
"""
import math, os, re
OUT = os.path.dirname(os.path.abspath(__file__))
INK, PAPER, EDGE = "#2f2628", "#fffaf0", "#fffdf8"
PINK = "#f4b6c2"

def dots(id, bg, fg="#fff", op=.6, s=3.4, r=.65):
    return f'<pattern id="{id}" width="{s}" height="{s}" patternUnits="userSpaceOnUse"><rect width="{s}" height="{s}" fill="{bg}"/><circle cx="{s/2}" cy="{s/2}" r="{r}" fill="{fg}" opacity="{op}"/></pattern>'
def stripes(id, bg, fg="#fff", op=.55, s=3, w=1.1, a=45):
    return f'<pattern id="{id}" width="{s}" height="{s}" patternUnits="userSpaceOnUse" patternTransform="rotate({a})"><rect width="{s}" height="{s}" fill="{bg}"/><rect width="{w}" height="{s}" fill="{fg}" opacity="{op}"/></pattern>'

def svg(name, comment, defs, sil, body):
    s = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <!-- {comment} -->
  <defs>
    {chr(10).join("    "+d for d in defs).strip()}
  </defs>
  <g fill="{EDGE}" stroke="{EDGE}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
    {chr(10).join("    "+x for x in sil).strip()}
  </g>
  {chr(10).join("  "+x for x in body).strip()}
</svg>
'''
    open(os.path.join(OUT, name + ".svg"), "w").write(s)

# ---- Fox head, local coords ~x±18, y-22..16 ----------------------------------
HEAD = "M0 16C-6 13-12 10-18 8-16 4-14.5 1-14-2-14-8-8-11 0-11 8-11 14-8 14-2 14.5 1 16 4 18 8 12 10 6 13 0 16Z"
MASK = "M-18 8C-12 5-6 4.5 0 7.5 6 4.5 12 5 18 8 12 10 6 13 0 16-6 13-12 10-18 8Z"
EARS = {
    "fox":    ("M-13-3-12-19-3-10Z", "M-11.3-5.5-11.1-15.5-5.5-10Z"),
    "fennec": ("M-12-2-20-22-2-10Z", "M-10.8-5-17.3-18.3-4.6-10Z"),
    "round":  ("M-13.5-3C-14-12-12-16-9.5-16-7-16-5-13-3-10Z", "M-11.5-5.5C-12-11-11-13.5-9.5-13.5-8-13.5-6.5-11.5-5.5-9.5Z"),
}
def mirror(d):
    # mirror an ear path across x=0 (paths above use only absolute M/L/C/Z with x,y pairs)
    toks = re.findall(r"[MLCZ]|-?\d*\.?\d+", d)
    res, pair = [], []
    for t in toks:
        if t in "MLCZ": res.append(t); continue
        pair.append(float(t))
        if len(pair) == 2:
            res.append(f"{-pair[0]:g} {pair[1]:g}"); pair = []
    return " ".join(res).replace(" Z", "Z")

def fox(tf, fur, ear="fox", inner=INK, mask=PAPER, eyes="open", extra_front=(), extra_back_sil=(), extra_back=()):
    eo, ei = EARS[ear]
    ears = f'<path d="{eo}"/><path d="{mirror(eo)}"/>'
    sil = [f'<g transform="{tf}">{ears}<path d="{HEAD}"/></g>']
    if eyes == "open":
        eye = f'<ellipse cx="-6" cy="1" rx="1.6" ry="2.1" fill="{INK}"/><ellipse cx="6" cy="1" rx="1.6" ry="2.1" fill="{INK}"/><circle cx="-5.5" cy=".2" r=".55" fill="#fff"/><circle cx="6.5" cy=".2" r=".55" fill="#fff"/>'
    else:
        eye = f'<path d="M-8.2 2Q-6-.6-3.8 2M3.8 2Q6-.6 8.2 2" fill="none" stroke="{INK}" stroke-width="1.3" stroke-linecap="round"/>'
    body = [f'''<g transform="{tf}">
    <g fill="{fur}" stroke="{fur}" stroke-width="1.5" stroke-linejoin="round">{ears}</g>
    <path d="{ei}" fill="{inner}"/><path d="{mirror(ei)}" fill="{inner}"/>
    <path d="{HEAD}" fill="{fur}"/>
    <path d="{MASK}" fill="{mask}"/>
    {eye}
    <circle cx="-10" cy="6" r="1.6" fill="{PINK}"/><circle cx="10" cy="6" r="1.6" fill="{PINK}"/>
    <ellipse cx="0" cy="13.6" rx="2" ry="1.4" fill="{INK}"/>
  </g>''']
    return list(extra_back_sil) + sil, list(extra_back) + body + list(extra_front)

# Studio: red fox in an indigo painter's beret
beret = '<g transform="translate(26 13) rotate(-14)"><ellipse rx="10.5" ry="4.2"/><rect x="-1" y="-6.5" width="2" height="3.5" rx="1"/></g>'
sil, body = fox("translate(24 27) scale(1.02)", "url(#fur)")
svg("studio", "Studio: a red fox in an indigo painter's beret",
    [stripes("fur", "#e8804a", "#fff", .25, 2.6, .8, 60), dots("beret", "#3e5d8c")],
    sil + [beret],
    body + [beret.replace("<ellipse", '<ellipse fill="url(#beret)"').replace("<rect", f'<rect fill="{INK}"')])

# Ideas: fox with closed eyes sniffing a yellow flower
petals = "".join(f'<circle cx="{38+3.4*math.cos(a):.2f}" cy="{37+3.4*math.sin(a):.2f}" r="2.7"/>' for a in [i*2*math.pi/5 - math.pi/2 for i in range(5)])
flower_sil = f'<path d="M38 37 34 45" stroke-width="7" fill="none"/>{petals}'
sil, body = fox("translate(22 25) scale(.98)", "url(#fur)", eyes="closed")
svg("ideas", "Ideas: a fox, eyes closed, sniffing a yellow flower",
    [dots("fur", "#ee8a4c", "#fff", .45, 3, .55)],
    sil + [flower_sil],
    body + [f'<path d="M38 38 34.5 44.5" stroke="#6f9a5c" stroke-width="1.8" stroke-linecap="round"/>',
            f'<path d="M35.5 42.5C33 42 32 40.5 32.5 39.5 34 39.5 35.5 40.5 35.5 42.5Z" fill="#7fa965"/>',
            f'<g fill="#f2c233">{petals}</g>', '<circle cx="38" cy="37" r="2.1" fill="#e8804a"/>'])

# Runes: sleepy fennec fox with huge ears
sil, body = fox("translate(24 28) scale(.93)", "url(#fur)", ear="fennec", inner=PINK, eyes="closed")
svg("runes", "Runes: a sleepy fennec fox",
    [stripes("fur", "#efcf98", "#e0b878", .8, 2.6, .8, -30)], sil, body)

# Yuniku: arctic fox, pale blue polka-dot
sil, body = fox("translate(24 27) scale(1.02)", "url(#fur)", ear="round", inner="#a9c4da", mask="#fffdf8")
svg("yuniku", "Yuniku: an arctic fox in pale blue polka-dot",
    [dots("fur", "#dde9f2", "#fff", .9, 3.2, .75)], sil, body)

# Japan Trip: a vermilion torii gate
kasagi = "M4 7.5Q24 13 44 7.5L42.5 12.5Q24 16.5 5.5 12.5Z"
cap = "M4 7.5Q24 13 44 7.5L43.5 9.3Q24 14.6 4.5 9.3Z"
beams = '<rect x="8" y="14" width="32" height="3"/><rect x="22.5" y="16.5" width="3" height="6"/><rect x="6" y="22" width="36" height="3.4"/>'
pillars = '<path d="M12.6 16H16.4L15.8 40H11.6Z"/><path d="M31.6 16H35.4L36.4 40H32.2Z"/>'
bases = '<path d="M11.2 38.5H16.2L16.4 43H10.8Z"/><path d="M31.8 38.5H36.8L37.2 43H31.6Z"/>'
petal = "M0-2.6C1.6-2.6 2.4-1 2 .6 1.6 2 .6 2.8 0 3 -.6 2.8-1.6 2-2 .6-2.4-1-1.6-2.6-.6-2.4L0-1.6.6-2.4Z"
petals = f'<path d="{petal}" transform="translate(41.5 31) rotate(35)"/><path d="{petal}" transform="translate(6 30) rotate(-25) scale(.8)"/>'
svg("japan-trip", "Japan Trip: a vermilion torii gate",
    [stripes("shu", "#e0573f", "#fff", .22, 3, 1, 90)],
    [f'<path d="{kasagi}"/>', beams, pillars, bases],
    [f'<g fill="url(#shu)">{pillars}{beams}</g>',
     f'<g fill="{INK}">{bases}</g>',
     f'<path d="{kasagi}" fill="url(#shu)"/>', f'<path d="{cap}" fill="{INK}"/>',
     f'<rect x="21.6" y="15.8" width="4.8" height="6.2" rx=".4" fill="{INK}"/>',
     '<rect x="22.5" y="16.7" width="3" height="4.4" fill="none" stroke="#f2b541" stroke-width=".5"/>'])

# portfolio-site: a dapper fox in a corduroy jacket and striped tie
jacket = "M7 45C8 38.5 13 35 19 34L24 40 29 34C35 35 40 38.5 41 45Z"
collar = '<path d="M19 34 24 40 21.5 41.5 17.5 35.5Z" fill="#fffaf0"/><path d="M29 34 24 40 26.5 41.5 30.5 35.5Z" fill="#fffaf0"/>'
tie = '<path d="M22.6 38.5H25.4L26.6 45H21.4Z" fill="url(#tie)"/><path d="M22.4 36.3H25.6L25.2 38.7H22.8Z" fill="#34507a"/>'
sil, body = fox("translate(24 20) scale(.82)", "url(#fur)", extra_back_sil=[f'<path d="{jacket}"/>'],
                extra_back=[f'<path d="{jacket}" fill="url(#cord)"/>', collar, tie])
svg("portfolio-site", "portfolio-site: a dapper fox in corduroy and a striped tie",
    [stripes("fur", "#d9733f", "#fff", .2, 2.6, .8, 60), stripes("cord", "#b98a55", "#a57642", 1, 1.6, .6, 0),
     stripes("tie", "#3e5d8c", "#f2b541", 1, 3, 1, 45)], sil, body)

# The Lab: the orange circle, as a sun
svg("the-lab", "The Lab: a bright orange sun, flat top-to-bottom gradient",
    ['<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb13d"/><stop offset=".55" stop-color="#ff6a1f"/><stop offset="1" stop-color="#f2410f"/></linearGradient>',
     dots("grain", "#fff", "#fff", 0, 2.6, .4).replace('opacity="0"', 'opacity=".35"').replace('<rect width="2.6" height="2.6" fill="#fff"/>', '')],
    ['<circle cx="24" cy="24" r="18"/>'],
    ['<circle cx="24" cy="24" r="18" fill="url(#sun)"/>', '<circle cx="24" cy="24" r="18" fill="url(#grain)"/>'])

# Ceramics: speckled celadon tea bowl with clay foot
bowl = "M7 19H41C41 30.5 34 38 24 38 14 38 7 30.5 7 19Z"
glaze = "M7 19H41C41 23 40.5 26 39.5 28.5 38 27.5 37 29 36.5 31 35 29.5 33.5 30 32.5 32.5 30.5 31 29 32 27.5 34 25.5 32 23 32.5 21.5 34.5 19.5 32.5 17.5 33 16 31 14 31.5 12.5 29.5 10.5 29.5 9 28 8 26 7 22.5 7 19Z"
svg("ceramics", "Ceramics: a speckled celadon tea bowl",
    [dots("clay", "#cf9467", "#a86a3e", .8, 2.8, .45), dots("glaze", "#9fc1b6", "#5f7f76", .7, 2.4, .35),
     f'<clipPath id="b"><path d="{bowl}"/></clipPath>'],
    [f'<path d="{bowl}"/>', '<rect x="17.5" y="36" width="13" height="5.5" rx="1.2"/>'],
    ['<rect x="17.5" y="36" width="13" height="5.5" rx="1.2" fill="#b97e52"/>',
     f'<path d="{bowl}" fill="url(#clay)"/>',
     f'<path d="{glaze}" fill="url(#glaze)" clip-path="url(#b)"/>',
     '<ellipse cx="24" cy="19" rx="17" ry="4.2" fill="#7fa39a"/>',
     '<ellipse cx="24" cy="19.8" rx="14.5" ry="3" fill="#6b8f86"/>'])

# Design Week: crossed ruler and pencil
ruler = '<rect x="-19" y="-4.5" width="38" height="9" rx="1.2"/>'
ticks = "".join(f'<path d="M{x} -4.5V{-1.5 if i%2 else -0.5}"/>' for i, x in enumerate(range(-15, 17, 3)))
pencil_body = '<path d="M-18-3.6H10L18.5 0 10 3.6H-18Z"/>'
svg("design-week", "Design Week 2026: a crossed ruler and pencil",
    [stripes("pen", "#f4b6c2", "#fff", .6, 3, 1.1, 0), stripes("rule", "#ffe066", "#f2c233", .9, 3, 1, 45)],
    [f'<g transform="translate(24 24) rotate(38)">{ruler}</g>', f'<g transform="translate(24 24) rotate(-40)"><path d="M-21-3.6H10L18.5 0 10 3.6H-21Z"/></g>'],
    [f'<g transform="translate(24 24) rotate(38)">{ruler.replace("/>", " fill=\"url(#rule)\"/>")}<g stroke="{INK}" stroke-width=".9">{ticks}</g></g>',
     f'''<g transform="translate(24 24) rotate(-40)">
    <rect x="-18" y="-3.6" width="28" height="7.2" fill="url(#pen)"/>
    <path d="M10-3.6 18.5 0 10 3.6Z" fill="#ebcd9f"/><path d="M15.4-1.3 18.5 0 15.4 1.3Z" fill="{INK}"/>
    <rect x="-20.8" y="-3.6" width="3" height="7.2" fill="#c9c3b8"/><path d="M-21-3.6H-23.2Q-24.6-3.6-24.6-2V2Q-24.6 3.6-23.2 3.6H-21Z" fill="#e0573f"/>
  </g>'''])

# Kodolab: a DNA double helix
def helix(sign):
    pts = [(24 + sign*9*math.sin((y-6)/36*2*math.pi*1.25), y) for y in [6 + i*0.9 for i in range(41)]]
    return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts)
rungs = [(24 + 9*math.sin((y-6)/36*2*math.pi*1.25), y) for y in range(9, 42, 4)]
rung_d = "".join(f'<path d="M{x:.2f} {y} H{48-x:.2f}" stroke="{c}"/>' for (x, y), c in zip(rungs, ["#f2b541", "#e0573f", "#7fa965", "#3e5d8c"]*3) if abs(x-24) > 2)
rung_sil = "".join(f'<path d="M{x:.2f} {y} H{48-x:.2f}"/>' for (x, y) in rungs if abs(x-24) > 2)
svg("kodolab", "Kodolab: a DNA double helix in washi",
    [stripes("a", "#4cc9f0", "#fff", .5, 3, 1.1, 45), dots("b", "#ea8048", "#fff", .6, 3, .6)],
    [f'<path d="{helix(1)}" fill="none" stroke-width="9"/>', f'<path d="{helix(-1)}" fill="none" stroke-width="9"/>',
     f'<g fill="none" stroke-width="6">{rung_sil}</g>'],
    [f'<g stroke-width="2" stroke-linecap="round">{rung_d}</g>',
     f'<path d="{helix(-1)}" fill="none" stroke="url(#b)" stroke-width="4" stroke-linecap="round"/>',
     f'<path d="{helix(1)}" fill="none" stroke="url(#a)" stroke-width="4" stroke-linecap="round"/>'])

# Nudibranch Ranch: purple sea slug with orange frills
nbody = "M5 33C5 27 11 23.5 19 23 27 21.5 36 22.5 41.5 27.5 44 30 43.5 34 40 35 30 37.5 16 37.5 8 36.5 6 36 5 34.5 5 33Z"
frill = "M6 35.5" + "".join(f"Q{7.5+i*4.2:.1f} 39.5 {9.6+i*4.2:.1f} 36.3" for i in range(8))
rhino = '<path d="M13 24 11 15.5M17 23 17.5 14.5" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
gills = "".join(f'<path d="M35 24 {35+6*math.cos(a):.1f} {24+6*math.sin(a):.1f}"/>' for a in [math.radians(d) for d in (-150, -120, -90, -60, -30)])
svg("nudibranch-ranch", "Nudibranch Ranch: a purple nudibranch with orange frills",
    [dots("body", "#9b7fd4", "#fff", .55, 3.2, .6)],
    [f'<path d="{nbody}"/>', f'<path d="{frill}" fill="none" stroke-width="7"/>',
     rhino.replace('stroke-width="2.4"', 'stroke-width="7"'), f'<g stroke-width="7" fill="none">{gills}</g>',
     '<circle cx="39" cy="11" r="3"/><circle cx="33" cy="7" r="2"/>'],
    [f'<path d="{frill}" fill="none" stroke="#f2a03d" stroke-width="2.4" stroke-linecap="round"/>',
     f'<path d="{nbody}" fill="url(#body)"/>',
     '<path d="M10 27.5C18 25 30 24.5 38 28" fill="none" stroke="#f7d36b" stroke-width="1.6" stroke-linecap="round"/>',
     rhino.replace("<path", '<path stroke="#6c52a8"'),
     '<circle cx="11" cy="15.5" r="1.7" fill="#f2a03d"/><circle cx="17.5" cy="14.5" r="1.7" fill="#f2a03d"/>',
     f'<g stroke="#f2a03d" stroke-width="2.2" stroke-linecap="round" fill="none">{gills}</g>',
     f'<circle cx="11.5" cy="28.5" r="1.2" fill="{INK}"/>',
     '<g fill="#fffaf0" stroke="#86c3b0" stroke-width="1"><circle cx="39" cy="11" r="2.4"/><circle cx="33" cy="7" r="1.4"/></g>'])

# Plant Kits: a coleus leaf (serrated, dark-green edge, lime + cream centre, purple base)
def leaf(scale, teeth):
    L, R = [], []
    n = 22
    for i in range(n + 1):
        t = i / n
        y = 42 - 36*t
        w = 15*scale*(math.sin(math.pi*t)**0.75)
        d = (1.3*scale if (teeth and i % 2 and 0 < i < n) else 0)
        L.append((24 - w - d, y)); R.append((24 + w + d, y))
    pts = L + R[::-1]
    return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + "Z"
veins = '<path d="M24 41V10M24 33 16 25M24 33 32 25M24 26 18 19M24 26 30 19M24 20 20.5 15M24 20 27.5 15" fill="none" stroke="#9e5bd0" stroke-width="1.1" stroke-linecap="round"/>'
svg("plant-kits", "Plant Kits: a coleus leaf",
    [dots("edge", "#2f5a3a", "#fff", .25, 3, .45)],
    [f'<path d="{leaf(1, True)}" transform="rotate(-18 24 26)"/>'],
    [f'<g transform="rotate(-18 24 26)"><path d="{leaf(1, True)}" fill="url(#edge)"/>',
     f'<path d="{leaf(.72, True)}" fill="#c6db5f" transform="translate(0 -1)"/>',
     f'<path d="{leaf(.45, False)}" fill="#eef0a8" transform="translate(0 -2)"/>',
     '<ellipse cx="24" cy="37" rx="3" ry="4" fill="#b77ee0"/>', veins + '</g>'])

# Protopia: a globe with a sprout growing out of it
svg("protopia", "Protopia: a little globe with a sprout",
    [dots("sea", "#a9cbe0", "#fff", .7, 3.2, .6), stripes("land", "#43c98b", "#fff", .35, 2.6, .9, 45),
     '<clipPath id="g"><circle cx="24" cy="29" r="13"/></clipPath>'],
    ['<circle cx="24" cy="29" r="13"/>', '<path d="M24 17V9" stroke-width="7" fill="none"/>',
     '<path d="M24 11C21 11 17 9.5 16 5.5 20 5 23.5 7 24 11ZM24 12C27 11 31 8.5 31.5 4.5 27.5 4.5 24.5 7 24 12Z"/>'],
    ['<circle cx="24" cy="29" r="13" fill="url(#sea)"/>',
     '<g clip-path="url(#g)" fill="url(#land)"><path d="M11 25C15 21 19 23 21 26 23 29 19 33 15 33 12 33 10 29 11 25Z"/><path d="M27 19C31 18 36 21 37 25 34 27 30 25 28 27 26 29 29 34 32 36 30 40 25 41 24 38 22 35 26 32 25 29 23 26 24 21 27 19Z"/></g>',
     '<path d="M24 17V9.5" stroke="#5f8f4a" stroke-width="1.8" stroke-linecap="round"/>',
     '<path d="M24 11C21 11 17 9.5 16 5.5 20 5 23.5 7 24 11Z" fill="#7fa965"/>',
     '<path d="M24 12C27 11 31 8.5 31.5 4.5 27.5 4.5 24.5 7 24 12Z" fill="#94b973"/>'])

# Robot Hackathon: a friendly robot
svg("robot-hackathon", "Robot Hackathon: a friendly robot",
    [dots("head", "#a9cbe0", "#fff", .7, 3.2, .6), stripes("body", "#f2b541", "#fff", .5, 3, 1.1, 45)],
    ['<path d="M24 12V6" stroke-width="7" fill="none"/>', '<circle cx="24" cy="5.5" r="2.6"/>',
     '<rect x="11" y="11" width="26" height="20" rx="5"/>', '<rect x="15" y="31" width="18" height="12" rx="3"/>',
     '<path d="M15 35 9 39M33 35 39 39" stroke-width="8" fill="none"/>',
     '<rect x="8" y="17" width="4" height="8" rx="2"/><rect x="36" y="17" width="4" height="8" rx="2"/>'],
    [f'<path d="M24 12V6" stroke="{INK}" stroke-width="1.6"/>', '<circle cx="24" cy="5.5" r="2.4" fill="#e0573f"/>',
     f'<path d="M15 35 9.5 38.5M33 35 38.5 38.5" stroke="#c9c3b8" stroke-width="3" stroke-linecap="round"/>',
     '<rect x="15" y="31" width="18" height="12" rx="3" fill="url(#body)"/>',
     f'<circle cx="21" cy="37" r="1.4" fill="{INK}"/><circle cx="27" cy="37" r="1.4" fill="#e0573f"/>',
     '<rect x="8" y="17" width="4" height="8" rx="2" fill="#e0573f"/><rect x="36" y="17" width="4" height="8" rx="2" fill="#e0573f"/>',
     '<rect x="11" y="11" width="26" height="20" rx="5" fill="url(#head)"/>',
     f'<rect x="14.5" y="14.5" width="19" height="12.5" rx="3.5" fill="{INK}"/>',
     '<circle cx="20" cy="20.5" r="2.1" fill="#8ff0c4"/><circle cx="28" cy="20.5" r="2.1" fill="#8ff0c4"/>',
     '<path d="M21.5 24Q24 25.8 26.5 24" fill="none" stroke="#8ff0c4" stroke-width="1.1" stroke-linecap="round"/>',
     f'<circle cx="15.5" cy="28.5" r="1.3" fill="{PINK}"/><circle cx="32.5" cy="28.5" r="1.3" fill="{PINK}"/>'])

# 2058: a retro-future diary with a ringed-planet clasp
svg("2058", "2058: a retro-future diary with a ringed-planet clasp",
    ['<pattern id="stars" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="#34507a"/><circle cx="2" cy="2" r=".6" fill="#fff"/><circle cx="6.5" cy="4" r=".4" fill="#fff" opacity=".8"/><circle cx="4" cy="7.5" r=".5" fill="#fff" opacity=".6"/></pattern>',
     stripes("strap", "#43e8a0", "#fff", .45, 2.6, .9, 45)],
    ['<g transform="rotate(-6 24 24)"><rect x="10" y="7" width="28" height="35" rx="2.5"/><rect x="33" y="21" width="9" height="8" rx="2"/></g>'],
    ['''<g transform="rotate(-6 24 24)">
    <rect x="10" y="7" width="28" height="35" rx="2.5" fill="url(#stars)"/>
    <rect x="10" y="7" width="4.5" height="35" rx="1.5" fill="#263d60"/>
    <rect x="18" y="11.5" width="15" height="7" rx="1" fill="#fffaf0"/>
    <text x="25.5" y="17" text-anchor="middle" font-family="Futura, Avenir, sans-serif" font-weight="700" font-size="5.6" fill="#2f2628">2058</text>
    <rect x="30" y="22" width="11" height="6" rx="1.5" fill="url(#strap)"/>
    <circle cx="24" cy="31" r="4.4" fill="#f2b541"/>
    <ellipse cx="24" cy="31" rx="8" ry="2.2" fill="none" stroke="#ea8048" stroke-width="1.4" transform="rotate(-18 24 31)"/>
    <path d="M19.8 29.1A4.4 4.4 0 0 1 28.2 29.3" fill="#f2b541"/>
  </g>'''])
print("wrote", len([f for f in os.listdir(OUT) if f.endswith(".svg")]), "stickers to", OUT)
