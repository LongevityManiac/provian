#!/usr/bin/env python3
"""Export the four narrative papers from their canonical Markdown sources.

Requires local pandoc and reportlab. Writes only to the explicit output directory;
it performs no publication, upload, or update of a live document mirror.
"""
import argparse
import hashlib
import html
import json
from pathlib import Path
import subprocess

import reportlab
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, HRFlowable,
)

ROOT = Path(__file__).resolve().parent.parent
PAPERS = [
    ('reference/Provian_Founding_Statement_v16.md', 'founding-statement', 'Founding Statement'),
    ('reference/Provian_Executive_Summary.md', 'executive-summary', 'Executive Summary'),
    ('reference/The_Exponential_Currency.md', 'the-exponential-currency', 'The Exponential Currency'),
    ('reference/TheProvianThesis_v24.md', 'the-provian-thesis', 'The Provian Thesis'),
]


def typography(text):
    return text.translate(str.maketrans({'\u2011': '-', '\u2013': '-', '\u2014': ' - ', '\u2212': '-'}))


def inline(nodes):
    parts = []
    for node in nodes:
        kind, value = node['t'], node.get('c')
        if kind == 'Str':
            parts.append(html.escape(typography(value)))
        elif kind in ('Space', 'SoftBreak'):
            parts.append(' ')
        elif kind == 'LineBreak':
            parts.append('<br/>')
        elif kind in ('Strong', 'Emph'):
            tag = 'b' if kind == 'Strong' else 'i'
            parts.append(f'<{tag}>{inline(value)}</{tag}>')
        elif kind == 'Link':
            label, target = inline(value[1]), value[2][0]
            parts.append(f'<link href="{html.escape(target, quote=True)}" color="#195880">{label}</link>'
                         if target.startswith(('https://', 'mailto:')) else label)
        elif kind == 'Code':
            parts.append(html.escape(typography(value[1])))
        else:
            raise ValueError(f'Unrendered inline type: {kind}')
    return ''.join(parts)


def export_papers(output):
    fonts = Path(reportlab.__file__).parent / 'fonts'
    for name, file in [('Paper', 'Vera.ttf'), ('PaperBold', 'VeraBd.ttf'),
                       ('PaperItalic', 'VeraIt.ttf'), ('PaperBoldItalic', 'VeraBI.ttf')]:
        pdfmetrics.registerFont(TTFont(name, str(fonts / file)))
    pdfmetrics.registerFontFamily('Paper', normal='Paper', bold='PaperBold',
                                 italic='PaperItalic', boldItalic='PaperBoldItalic')
    body = ParagraphStyle('body', fontName='Paper', fontSize=10, leading=15.2,
                          textColor=colors.HexColor('#18242d'), spaceAfter=10,
                          allowWidows=0, allowOrphans=0, alignment=TA_LEFT)
    headings = {
        1: ParagraphStyle('title', parent=body, fontName='PaperBold', fontSize=26,
                          leading=31, spaceAfter=21, spaceBefore=0, keepWithNext=True),
        2: ParagraphStyle('section', parent=body, fontName='PaperBold', fontSize=15,
                          leading=20, spaceBefore=17, spaceAfter=10, keepWithNext=True),
        3: ParagraphStyle('subsection', parent=body, fontName='PaperBold', fontSize=11.5,
                          leading=16, spaceBefore=12, keepWithNext=True),
    }

    def blocks(nodes, depth=0):
        result = []
        for node in nodes:
            kind, value = node['t'], node.get('c')
            if kind in ('Para', 'Plain'):
                result.append(Paragraph(inline(value), body))
            elif kind == 'Header':
                result.append(Paragraph(inline(value[2]), headings[min(value[0], 3)]))
            elif kind == 'HorizontalRule':
                result.extend([Spacer(1, 5), HRFlowable(width='100%', thickness=.5,
                               color=colors.HexColor('#bcc9d1')), Spacer(1, 12)])
            elif kind in ('BulletList', 'OrderedList'):
                start = value[0][0] if kind == 'OrderedList' else 1
                items = value[1] if kind == 'OrderedList' else value
                for index, item in enumerate(items, start):
                    if not item or item[0]['t'] not in ('Plain', 'Para'):
                        raise ValueError('List item must begin with readable text')
                    label = str(index) + '.' if kind == 'OrderedList' else '\u2022'
                    style = ParagraphStyle('list', parent=body, leftIndent=16 * (depth + 1),
                                           firstLineIndent=0, bulletIndent=16 * depth, spaceAfter=7)
                    result.append(Paragraph(inline(item[0]['c']), style, bulletText=label))
                    result.extend(blocks(item[1:], depth + 1))
            elif kind == 'BlockQuote':
                result.extend(blocks(value, depth + 1))
            else:
                raise ValueError(f'Unrendered block type: {kind}')
        return result

    output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for source, slug, title in PAPERS:
        source_path, target = ROOT / source, output / (slug + '.pdf')
        ast = json.loads(subprocess.check_output(['pandoc', '-f', 'gfm', '-t', 'json', str(source_path)]))
        story = blocks(ast['blocks'])
        if not story:
            raise ValueError(f'Empty paper: {source}')

        def page(canvas, document):
            canvas.saveState()
            canvas.setStrokeColor(colors.HexColor('#cbd4db'))
            canvas.line(54, 45, 558, 45)
            canvas.setFont('Paper', 8)
            canvas.setFillColor(colors.HexColor('#53616d'))
            canvas.drawString(54, 30, 'PROVIAN  /  ' + title)
            canvas.drawRightString(558, 30, str(document.page))
            canvas.restoreState()

        document = SimpleDocTemplate(str(target), pagesize=(612, 792), rightMargin=54,
                                     leftMargin=54, topMargin=49, bottomMargin=62,
                                     title=title, author='Provian', pageCompression=1)
        document.build(story, onFirstPage=page, onLaterPages=page)
        copied = output / source_path.name
        copied.write_bytes(source_path.read_bytes())
        manifest.append({'source': source, 'sourceSha256': hashlib.sha256(source_path.read_bytes()).hexdigest(),
                         'pdf': target.name, 'pdfSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                         'markdown': copied.name, 'pages': document.page})
    (output / 'papers-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'papers': len(manifest), 'pages': sum(row['pages'] for row in manifest)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    export_papers(parser.parse_args().output.resolve())
