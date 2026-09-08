#!/usr/bin/env node
/**
 * Build the binary fixtures the extractor tests read.
 *
 * The files are **committed**, and this script exists to say where they came
 * from rather than to run in CI: a test that generates what it then reads
 * proves the generator and the extractor agree, which is not the question. A
 * committed file is a file somebody looked at once.
 *
 *     node scripts/make-knowledge-fixtures.mjs        # from apps/api
 *
 * Two of them are not regenerated here and are documented instead:
 *
 *  - `twocol.pdf` — a real two-column document, typeset from `twocol.tex`
 *    with pdflatex and Latin Modern. Needs a TeX distribution; the committed
 *    PDF is the reference. Rebuild with:
 *        pdflatex -interaction=nonstopmode twocol.tex
 *  - `encrypted.pdf` — `assurance.pdf` sealed with a user password. Needs
 *    PyMuPDF; this script writes it when Python has it and says so otherwise.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import pptxgen from 'pptxgenjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'learning', 'extract', 'fixtures');
mkdirSync(out, { recursive: true });

const write = (name, data) => {
  writeFileSync(join(out, name), data);
  console.log(`wrote ${name} (${(Buffer.byteLength(data) / 1024).toFixed(1)} KiB)`);
};

/* -- bail.docx: headings, bold, a table, a list ---------------------------- */
{
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "Bail d'habitation — 12 rue des Lilas", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: 'Loyer et charges', heading: HeadingLevel.HEADING_2 }),
          new Paragraph(
            "Le loyer mensuel s'élève à 950 euros hors charges, auxquels s'ajoute une provision de 110 euros pour les charges récupérables. Le règlement intervient le 5 de chaque mois par virement.",
          ),
          new Paragraph({ text: 'Résiliation par le locataire', heading: HeadingLevel.HEADING_2 }),
          new Paragraph(
            'Le locataire peut donner congé à tout moment. Le délai de préavis est de trois mois, ramené à un mois lorsque le logement se situe en zone tendue.',
          ),
          new Paragraph({
            children: [
              new TextRun({ text: 'Important : ', bold: true }),
              new TextRun('le congé est notifié par lettre recommandée avec accusé de réception.'),
            ],
          }),
          new Paragraph({ text: 'Échéancier', heading: HeadingLevel.HEADING_2 }),
          new Table({
            rows: [
              ['Poste', 'Montant'],
              ['Loyer', '950 €'],
              ['Charges', '110 €'],
            ].map(
              (cells) =>
                new TableRow({
                  children: cells.map(
                    (text) => new TableCell({ children: [new Paragraph(text)] }),
                  ),
                }),
            ),
          }),
          new Paragraph({ text: 'Liste', heading: HeadingLevel.HEADING_3 }),
          new Paragraph({ text: 'Premier point', bullet: { level: 0 } }),
          new Paragraph({ text: 'Deuxième point', bullet: { level: 0 } }),
        ],
      },
    ],
  });
  write('bail.docx', await Packer.toBuffer(document));
}

/* -- empty.docx and empty.xlsx: valid files with nothing to read ----------- */
{
  write(
    'empty.docx',
    await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('')] }] })),
  );
  const blank = new ExcelJS.Workbook();
  blank.addWorksheet('Vide');
  write('empty.xlsx', Buffer.from(await blank.xlsx.writeBuffer()));
}

/* -- loyers.xlsx: two sheets, dates, formulas, a gap ----------------------- */
{
  const workbook = new ExcelJS.Workbook();
  const rents = workbook.addWorksheet('Loyers 2026');
  rents.columns = [
    { header: 'Mois', key: 'm' },
    { header: 'Échéance', key: 'd' },
    { header: 'Loyer', key: 'l' },
    { header: 'Charges', key: 'c' },
    { header: 'Total', key: 't' },
  ];
  for (let month = 0; month < 12; month += 1) {
    rents.addRow({
      m: `2026-${String(month + 1).padStart(2, '0')}`,
      d: new Date(Date.UTC(2026, month, 5)),
      l: 950,
      c: 110,
      t: { formula: `C${month + 2}+D${month + 2}`, result: 1060 },
    });
  }
  rents.getColumn('d').numFmt = 'dd/mm/yyyy';

  const contacts = workbook.addWorksheet('Contacts');
  contacts.addRow(['Rôle', 'Nom', 'Téléphone']);
  contacts.addRow(['Bailleur', 'Mme Durand', '06 12 34 56 78']);
  contacts.addRow(['Syndic', 'Cabinet Foncia', '01 23 45 67 89']);
  // A blank row, then a note: a real sheet is not a dense rectangle.
  contacts.addRow([null, null, null]);
  contacts.addRow(['Note', 'Le syndic gère les parties communes ; contacter en cas de fuite.', null]);

  write('loyers.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
}

/* -- deploiement.pptx: titles, a table, speaker notes ---------------------- */
{
  const deck = new pptxgen();
  // Slide 1 carries a real title *placeholder*, the way PowerPoint writes a
  // deck; slides 2 and 3 use plain text boxes, which is how a deck built by
  // dragging boxes around comes out. The extractor has to read both, so the
  // fixture contains both.
  deck.defineSlideMaster({
    title: 'TITRE',
    objects: [
      { placeholder: { options: { name: 'titre', type: 'title', x: 0.5, y: 0.4, w: 9, h: 1 }, text: '' } },
    ],
  });
  const first = deck.addSlide({ masterName: 'TITRE' });
  first.addText('Plan de déploiement', { placeholder: 'titre' });
  first.addText(
    [
      { text: 'Objectif : migrer la prod avant le 30 septembre', options: { bullet: true } },
      { text: 'Fenêtre : dimanche 03h–05h', options: { bullet: true } },
    ],
    { x: 0.5, y: 1.5, w: 9, h: 3 },
  );
  first.addNotes('Rappeler que la fenêtre a été validée par le client le 2 septembre.');

  const second = deck.addSlide();
  second.addText('Risques', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 32 });
  second.addTable(
    [
      [{ text: 'Risque' }, { text: 'Parade' }],
      ['Perte de données', 'Sauvegarde à froid avant bascule'],
      ['Rollback impossible', 'Image précédente conservée 7 jours'],
    ],
    { x: 0.5, y: 1.5, w: 9 },
  );
  second.addNotes('Le rollback est testé en préprod chaque semaine.');

  const third = deck.addSlide();
  third.addText('Questions ?', { x: 0.5, y: 2, w: 9, h: 1, fontSize: 40 });

  write('deploiement.pptx', Buffer.from(await deck.write({ outputType: 'nodebuffer' })));
}

/* -- assurance.pdf: three pages, and scan.pdf: no text layer --------------- */
{
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = [
    [
      'CONTRAT MULTIRISQUE HABITATION',
      [
        "Article 1 - Déclaration d'un sinistre",
        "Tout sinistre doit être déclaré à l'assureur dans les cinq jours ouvrés",
        'suivant sa constatation. Ce délai est ramené à deux jours ouvrés en cas',
        "de vol ou de tentative d'effraction.",
      ],
    ],
    [
      '',
      [
        'Article 2 - Franchise',
        "Une franchise de 150 euros reste à la charge de l'assuré pour tout",
        "sinistre, sauf catastrophe naturelle où la franchise légale s'applique.",
      ],
    ],
    [
      '',
      [
        'Article 3 - Résiliation',
        "Le contrat peut être résilié chaque année à l'échéance, moyennant un",
        'préavis de deux mois, par lettre recommandée.',
      ],
    ],
  ];
  for (const [title, lines] of pages) {
    const page = pdf.addPage([595, 842]);
    let y = 780;
    if (title) {
      page.drawText(title, { x: 60, y, size: 16, font: bold });
      y -= 40;
    }
    for (const line of lines) {
      page.drawText(line, { x: 60, y, size: 11, font: regular });
      y -= 18;
    }
  }
  write('assurance.pdf', Buffer.from(await pdf.save()));

  // A page with a rectangle and no text: the stand-in for a scan.
  const scan = await PDFDocument.create();
  scan.addPage([595, 842]).drawRectangle({ x: 50, y: 50, width: 400, height: 600 });
  write('scan.pdf', Buffer.from(await scan.save()));
}

/* -- the plain-text family ------------------------------------------------- */
write(
  'sample.csv',
  Buffer.from(
    [
      'Mois;Échéance;Loyer',
      '2026-01;05/01/2026;950',
      '2026-02;05/02/2026;950',
      '',
      '"Note";"Le syndic ; gère les parties communes";',
    ].join('\n'),
    'utf8',
  ),
);

write(
  'sample.html',
  Buffer.from(
    `<!doctype html><html><head><title>Guide</title><style>body{color:red}</style>
<script>alert(1)</script></head>
<body><nav><a href="/">Accueil</a></nav><main>
<h1>Runbook &amp; conventions</h1>
<p>Déployer avec <code>pnpm verify</code> d&rsquo;abord &mdash; voir <a href="https://example.com/x">la doc</a>.<br>Deuxième ligne.</p>
<h2>Étapes</h2><ol><li>Construire</li><li>Tester <em>entièrement</em></li></ol>
<table><thead><tr><th>Clé</th><th>Valeur</th></tr></thead><tbody><tr><td>timeout</td><td>30&nbsp;s</td></tr></tbody></table>
<div><p>Paragraphe final &#233;t&#xE9;.</p></div></main><footer>© 2026</footer></body></html>`,
    'utf8',
  ),
);

write(
  'sample.md',
  Buffer.from(
    `# Conventions

## Commits
Chaque poussée sur main incrémente la version.

## Tests
La commande \`pnpm verify\` enchaîne typecheck, tests, build et ratchets.
`,
    'utf8',
  ),
);

/* -- encrypted.pdf, when Python can seal it -------------------------------- */
if (existsSync(join(out, 'encrypted.pdf'))) {
  console.log('kept  encrypted.pdf (already present)');
} else {
  try {
    execFileSync(
      'python',
      [
        '-c',
        [
          'import fitz, sys',
          'doc = fitz.open(sys.argv[1])',
          'doc.save(sys.argv[2], encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")',
        ].join('\n'),
        join(out, 'assurance.pdf'),
        join(out, 'encrypted.pdf'),
      ],
      { stdio: 'pipe' },
    );
    console.log('wrote encrypted.pdf (via PyMuPDF)');
  } catch {
    console.log(
      'skip  encrypted.pdf — needs Python with PyMuPDF (`pip install pymupdf`); the committed file stands',
    );
  }
}

console.log(`\nfixtures in ${out}`);
