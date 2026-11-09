# Test data

Sample inputs for the create flow (video / document → guide). The video files are not committed
(too large); `fetch.sh` downloads them and cuts the clips.

## Videos (Wikimedia Commons; licenses per row)

A mix of apps on purpose, so processing isn't tuned to one app: desktop (macOS, Linux), web, narrated, silent and non-English.

| File | What it shows | Length | Source |
|---|---|---|---|
| `calc-import-data.webm` | LibreOffice Calc (macOS): import a comma-separated text file (File → Open → Text Import), narrated | 2:39 | "LibreOffice Calc –- Importing Data" by Rich Lewis, CC BY 3.0, https://commons.wikimedia.org/wiki/File:LibreOffice_Calc_%E2%80%93-_Importing_Data.webm |
| `calc-import-data-silent.webm` | Same, audio removed (tests the no-narration path) | 2:39 | derived from the above |
| `writer-export-pdf.webm` | LibreOffice Writer (Linux): export a document as PDF, narrated | 0:56 | clip 6:25–7:21 of "LibreOffice Writer – The Basics" by Free I.T. Athens, CC BY 3.0, https://commons.wikimedia.org/wiki/File:LibreOffice_Writer_%E2%80%93_The_Basics.webm |
| `writer-save-document.webm` | LibreOffice Writer (Linux): save a document, narrated | 2:30 | clip 3:58–6:28 of the same video |
| `commons-upload-image.webm` | Web (Wikimedia Commons in a browser): upload an image through the Upload Wizard, narrated | 1:59 | "How to Upload an Image to Wikimedia Commons (A Beginner's Guide 2025)" by Dev Jadiya, CC0, https://commons.wikimedia.org/wiki/File:How_to_Upload_an_Image_to_Wikimedia_Commons_(A_Beginner%27s_Guide_2025).webm |
| `moodle-upload-file.ogv` | Web (Moodle learning platform): add a file to a course topic, narrated | 1:56 | "Moodle2-upload-file" by Mosborne01, CC BY-SA 3.0, https://commons.wikimedia.org/wiki/File:Moodle2-upload-file.ogv |
| `inkscape-page-background-tamil.webm` | Inkscape (Linux): change the page background colour (File → Document Properties); from a Tamil tutorial series, but the quiet soundtrack has no recognisable speech; zooms in and out | 1:35 | "Inkscape-Tamil-changing-drawing-page-background" by Info-farmer, CC0, https://commons.wikimedia.org/wiki/File:Inkscape-Tamil-changing-drawing-page-background.webm |
| `wiki-csv-table.webm` | Web (Wikipedia VisualEditor): paste CSV data to create a table; no audio | 0:52 | "VisualEditor - demonstration of CSV table creation" by James D. Forrester, CC BY 3.0, https://commons.wikimedia.org/wiki/File:VisualEditor_-_demonstration_of_CSV_table_creation.webm |

Used only to test Qhint's processing; not redistributed.
