"""Regenerate the original CC0 test fonts with fontTools (test-only dependency)."""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont, TTCollection, newTable
from fontTools.ttLib.tables._f_v_a_r import Axis

OUT = Path(__file__).parent
GLYPHS = ['.notdef', 'space', 'box']

def draw(pen):
    pen.moveTo((80, 0))
    pen.lineTo((480, 0))
    pen.lineTo((480, 700))
    pen.lineTo((80, 700))
    pen.closePath()

def make(name, family, weight=400, otf=False, italic=False):
    fb = FontBuilder(1000, isTTF=not otf)
    fb.setupGlyphOrder(GLYPHS)
    fb.setupCharacterMap({32: 'space', **{c: 'box' for c in range(33, 127)}, **{ord(c): 'box' for c in '中文你好'}})
    if otf:
        chars = {}
        for glyph in GLYPHS:
            pen = T2CharStringPen(600, None)
            if glyph != 'space': draw(pen)
            chars[glyph] = pen.getCharString()
        fb.setupCFF(family.replace(' ', ''), {'FullName': family, 'FamilyName': family, 'Weight': 'Regular'}, chars, {})
    else:
        glyphs = {}
        for glyph in GLYPHS:
            pen = TTGlyphPen(None)
            if glyph != 'space': draw(pen)
            glyphs[glyph] = pen.glyph()
        fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({g: (600, 0) for g in GLYPHS})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    style = 'Italic' if italic else 'Bold' if weight == 700 else 'Regular'
    fb.setupNameTable({'familyName': family, 'styleName': style, 'uniqueFontIdentifier': family + style,
        'fullName': family + ' ' + style, 'psName': family.replace(' ', '') + '-' + style,
        'version': 'Version 1.000', 'copyright': 'Original PiDeck test fixture. CC0.'})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200,
        usWeightClass=weight, fsSelection=0x01 if italic else 0x20 if weight == 700 else 0x40)
    fb.setupPost(isFixedPitch=1, italicAngle=-12 if italic else 0)
    fb.setupMaxp()
    fb.font['head'].created = fb.font['head'].modified = 3800000000
    fb.font['head'].macStyle = 2 if italic else 1 if weight == 700 else 0
    fb.save(OUT / name)

make('regular.ttf', 'PiDeck Test Mono')
make('bold.ttf', 'PiDeck Test Mono', 700)
make('italic.ttf', 'PiDeck Test Mono', italic=True)
make('cff.otf', 'PiDeck Test CFF', otf=True)
collection = TTCollection()
collection.fonts = [TTFont(OUT / 'regular.ttf'), TTFont(OUT / 'bold.ttf')]
collection.save(OUT / 'collection.ttc')
make('variable.ttf', 'PiDeck Test Variable')
font = TTFont(OUT / 'variable.ttf')
font['fvar'] = newTable('fvar')
axis = Axis()
axis.axisTag, axis.minValue, axis.defaultValue, axis.maxValue = 'wght', 100, 400, 900
axis.flags = 0
axis.axisNameID = font['name'].addName('Weight')
font['fvar'].axes, font['fvar'].instances = [axis], []
font['gvar'] = newTable('gvar')
font['gvar'].variations = {glyph: [] for glyph in GLYPHS}
font.recalcTimestamp = False
font.save(OUT / 'variable.ttf')
