import argparse
import csv
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime

'''Export database as CSV, bundled into a zip archive.'''

parser = argparse.ArgumentParser(description="Exports IR database to CSV")
parser.add_argument("-s", "--Source", help="relative path to IR database", required=True)
parser.add_argument("-d", "--Destination", help="directory to output files to")
args = parser.parse_args()

destination = os.path.dirname(args.Source)
if args.Destination:
    destination = args.Destination

output_dir = os.path.abspath(destination)
conn = sqlite3.connect(args.Source)
cursor = conn.cursor()

tables = ['article', 'article_review', 'snippet', 'snippet_review', 'srs_card', 'srs_card_review']


def write_to_csv(table: str, dir: str):
    query = f'SELECT * FROM {table}'
    cursor.execute(query)
    file_path = os.path.join(dir, f'{table}.csv')
    with open(file_path, 'w', newline='') as csv_file:
        writer = csv.writer(csv_file)
        column_names = [desc[0] for desc in cursor.description]
        writer.writerow(column_names)
        writer.writerows(cursor.fetchall())


def resolve_conflict(path: str) -> str:
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    n = 1
    while os.path.exists(f'{base} ({n}){ext}'):
        n += 1
    return f'{base} ({n}){ext}'


tmp_dir = tempfile.mkdtemp()
try:
    for table in tables:
        write_to_csv(table, tmp_dir)

    timestamp = datetime.now().strftime('%Y-%m-%d_%H%M%S')
    archive_name = f'incremental-reading-export-{timestamp}'
    archive_path = resolve_conflict(os.path.join(output_dir, f'{archive_name}.zip'))

    shutil.make_archive(
        os.path.splitext(archive_path)[0],
        'zip',
        root_dir=tmp_dir,
    )
finally:
    shutil.rmtree(tmp_dir)

conn.close()
print(f"Exported to {archive_path}")