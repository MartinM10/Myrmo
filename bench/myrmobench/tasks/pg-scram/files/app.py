import pg8000

conn = pg8000.connect(host="127.0.0.1", port=5432, user="postgres", password="bench-secret", database="postgres")
cur = conn.cursor()
cur.execute("select 42")
print("DB OK", cur.fetchone()[0])
conn.close()
