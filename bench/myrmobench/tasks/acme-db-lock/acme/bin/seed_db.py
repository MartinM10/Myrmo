"""The billing database as a CI runner left it: schema 6, three customers, and the migration lock it never released."""
import sqlite3

db = sqlite3.connect("/var/acme/billing.db")
db.executescript("""
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
INSERT INTO customers (name, email) VALUES ('Lumen Labs', 'ops@lumen.example'), ('Borealis', 'it@borealis.example'),
                                           ('Quillwork', 'admin@quillwork.example');
CREATE TABLE _acme_schema (version INTEGER NOT NULL);
INSERT INTO _acme_schema VALUES (6);
CREATE TABLE _acme_locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, since TEXT NOT NULL, generation INTEGER NOT NULL);
CREATE TABLE _acme_lockseq (name TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE TABLE _acme_audit (ts TEXT NOT NULL, name TEXT NOT NULL, generation INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL);
INSERT INTO _acme_audit VALUES ('2026-10-02T03:10:00Z', 'migrate', 1, 'acquired', 'ci-runner-11'),
                               ('2026-10-02T03:10:09Z', 'migrate', 1, 'released', 'ci-runner-11'),
                               ('2026-10-05T03:11:00Z', 'migrate', 2, 'acquired', 'ci-runner-14'),
                               ('2026-10-05T03:11:12Z', 'migrate', 2, 'released', 'ci-runner-14'),
                               ('2026-10-09T03:12:00Z', 'migrate', 3, 'acquired', 'ci-runner-17');
INSERT INTO _acme_lockseq VALUES ('migrate', 3);
INSERT INTO _acme_locks VALUES ('migrate', 'ci-runner-17', '2026-10-09T03:12:00Z', 3);
""")
db.commit()
