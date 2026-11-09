#!/usr/bin/env bash
# Downloads the sample videos (see README.md for sources and licenses) and cuts the clips.
set -euo pipefail
cd "$(dirname "$0")" && mkdir -p videos && cd videos
UA="QhintDev/0.1 (test data)"
curl -sSL -A "$UA" -o calc-import-data.webm "https://upload.wikimedia.org/wikipedia/commons/d/db/LibreOffice_Calc_%E2%80%93-_Importing_Data.webm"
curl -sSL -A "$UA" -o writer-basics.webm "https://upload.wikimedia.org/wikipedia/commons/1/18/LibreOffice_Writer_%E2%80%93_The_Basics.webm"
get() { sleep 3; curl -sSL -A "$UA" -o "$1" "$2"; } # slow down: Wikimedia rate-limits bursts
get commons-upload-image.webm "https://upload.wikimedia.org/wikipedia/commons/9/95/How_to_Upload_an_Image_to_Wikimedia_Commons_%28A_Beginner%27s_Guide_2025%29.webm"
get moodle-upload-file.ogv "https://upload.wikimedia.org/wikipedia/commons/b/b3/Moodle2-upload-file.ogv"
get inkscape-page-background-tamil.webm "https://upload.wikimedia.org/wikipedia/commons/$(python3 -c "import hashlib;n='Inkscape-Tamil-changing-drawing-page-background.webm';h=hashlib.md5(n.encode()).hexdigest();print(h[0]+'/'+h[:2]+'/'+n)")"
get wiki-csv-table.webm "https://upload.wikimedia.org/wikipedia/commons/4/44/VisualEditor_-_demonstration_of_CSV_table_creation.webm"
ffmpeg -v error -y -i calc-import-data.webm -an -c:v copy calc-import-data-silent.webm
ffmpeg -v error -y -ss 385 -to 440 -i writer-basics.webm -c copy writer-export-pdf.webm
ffmpeg -v error -y -ss 238 -to 385 -i writer-basics.webm -c copy writer-save-document.webm
echo "test videos ready in $(pwd)"
