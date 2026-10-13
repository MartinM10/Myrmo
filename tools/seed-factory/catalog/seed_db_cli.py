"""Database client and configuration errors that need no running server, or a server the task starts itself offline.

Each task runs in a disposable container. Postgres tasks start a local cluster (trust authentication on the local
socket and on 127.0.0.1) as the postgres user; Redis tasks start redis-server on a local port or socket; SQLite tasks
use the Python standard library. No credentials, no network.
"""

from .base import Task

REDIS = {"name": "redis", "version": "7"}
POSTGRES = {"name": "postgresql", "version": "15.5"}
PYTHON = {"name": "python", "version": "3.12.4"}


def _pg_up(auth_host: str = "trust", after: str = "") -> str:
    """Initialise and start a local cluster that listens on 127.0.0.1 and on the socket /tmp/pgsock."""
    return (
        "install -d -o postgres -g postgres /tmp/pgsock && "
        f"runuser -u postgres -- initdb -D /tmp/pgdata --auth-host={auth_host} >/dev/null && "
        "runuser -u postgres -- pg_ctl -D /tmp/pgdata -o '-k /tmp/pgsock -c listen_addresses=127.0.0.1' -l /tmp/pg.log -w start >/dev/null"
        + after
    )


PG_SOCKET_DIR = "psql -h /var/run/postgresql -U postgres -tAc 'select 1'"
PG_TCP = "psql -h 127.0.0.1 -U postgres -tAc 'select 1'"

TASKS = (
    Task(
        "redis-cli-closed-port", "redis:7-alpine", REDIS, "network", "Connection refused",
        "redis-cli fails with Could not connect to Redis at 127.0.0.1:6390: Connection refused because no redis-server listens on the port the client was given.",
        "Checking a Redis instance from a container whose start script was supposed to run redis-server on port 6390 but never did.",
        "",
        "redis-cli -p 6390 ping",
        ("redis-cli -h 127.0.0.1 -p 6390 ping", "redis-cli ping"),
        "redis-server --port 6390 --save '' --appendonly no --daemonize yes >/dev/null && sleep 1",
        "redis-cli -p 6390 ping | grep -qx PONG",
        "redis-cli only connects, it starts nothing. The server it targets is not running on that port, so the TCP connection is refused before any Redis command is sent.",
        ("Find the port the server is configured for (the port option in its config file or service definition) and compare it with the port the client uses.", "Start redis-server on that port, or point the client at the port the server really listens on.", "Check with redis-cli -p 6390 ping; PONG means the server is reachable."),
        ("redis", "redis-cli", "network", "connection-refused"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "redis-cli-missing-unix-socket", "redis:7-alpine", REDIS, "network", "No such file or directory",
        "redis-cli -s fails with Could not connect to Redis at /run/redis/redis.sock: No such file or directory because the socket file was never created by a server.",
        "Connecting to a Redis instance through a unix socket path in a container where the server is meant to listen only on that socket.",
        "",
        "redis-cli -s /run/redis/redis.sock ping",
        ("redis-cli -s /var/run/redis/redis.sock ping", "redis-cli -h /run/redis/redis.sock ping"),
        "mkdir -p /run/redis && redis-server --port 0 --unixsocket /run/redis/redis.sock --unixsocketperm 777 --daemonize yes >/dev/null && sleep 1",
        "redis-cli -s /run/redis/redis.sock ping | grep -qx PONG",
        "A unix socket is a file that exists only while a server bound to it is running. With no server started with --unixsocket, connect() finds no file and reports ENOENT, which redis-cli prints as No such file or directory.",
        ("Check the unixsocket option of the server configuration and the path the client passes to -s; they must be identical.", "Create the socket's directory, then start redis-server with --port 0 (no TCP) and --unixsocket pointing at the same path.", "Confirm with redis-cli -s <path> ping, which must answer PONG."),
        ("redis", "redis-cli", "unix-socket", "configuration"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "psql-socket-directory-missing", "postgres:15.5", POSTGRES, "network", "No such file or directory",
        "psql cannot reach a cluster through the socket directory /var/run/postgresql, because no server is running and no socket file exists there.",
        "Running psql in a container that has the Postgres client but no running cluster.",
        "",
        PG_SOCKET_DIR,
        ("pg_isready -h /var/run/postgresql", "psql -h 127.0.0.1 -p 5432 -U postgres -tAc 'select 1'"),
        "install -d -o postgres -g postgres /var/run/postgresql && runuser -u postgres -- initdb -D /tmp/pgdata >/dev/null && runuser -u postgres -- pg_ctl -D /tmp/pgdata -o '-k /var/run/postgresql' -l /tmp/pg.log -w start >/dev/null",
        PG_SOCKET_DIR + " | grep -qx 1",
        "libpq connects to the file <directory>/.s.PGSQL.<port>. That file exists only while a server runs with that socket directory. No server ran here, so the socket file is absent.",
        ("Confirm a server is running: pg_isready -h <dir> reports no response when none is.", "Start a cluster whose unix_socket_directories (the -k option of pg_ctl) is the directory the client uses.", "Check the connection with psql -h <dir> -U postgres -tAc 'select 1'."),
        ("postgresql", "psql", "unix-socket", "libpq"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "psql-pgport-mismatch", "postgres:15.5", POSTGRES, "configuration", "Connection refused",
        "psql connects to the wrong TCP port because a stale PGPORT=5433 is exported while the cluster listens on 5432, so the connection is refused.",
        "A shell where PGPORT was exported with a value left over from an older deployment.",
        _pg_up(after="; export PGPORT=5433"),
        PG_TCP,
        ("psql -h 127.0.0.1 -p 5433 -U postgres -tAc 'select 1'", "pg_isready -h 127.0.0.1 -p 5433"),
        "unset PGPORT",
        PG_TCP + " | grep -qx 1",
        "PGPORT overrides the default port for libpq and psql. The client asks for 5433 while the cluster listens on 5432, so the TCP connection is refused. The server is fine; the environment disagrees with it.",
        ("Run env | grep PG to see which variables the shell sets for libpq clients.", "Remove the stale PGPORT, or set it to the port the cluster listens on (pg_lsclusters or SHOW port).", "Verify with psql -h 127.0.0.1 -U postgres -tAc 'select 1'."),
        ("postgresql", "psql", "libpq", "environment"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "psql-invalid-sslmode", "postgres:15.5", POSTGRES, "configuration", "invalid sslmode value",
        "libpq rejects a connection string before connecting because verify_full is not a valid sslmode value; the accepted values are spelled with hyphens.",
        "A connection string passed to psql that uses an underscore where libpq expects a hyphen.",
        _pg_up(),
        "psql \"host=127.0.0.1 user=postgres dbname=postgres sslmode=verify_full\" -tAc 'select 1'",
        ("PGSSLMODE=verify_full psql -h 127.0.0.1 -U postgres -tAc 'select 1'", "psql -h 127.0.0.1 -U postgres 'sslmode=require' -tAc 'select 1'"),
        "psql \"host=127.0.0.1 user=postgres dbname=postgres sslmode=prefer\" -tAc 'select 1' >/dev/null",
        "psql \"host=127.0.0.1 user=postgres dbname=postgres sslmode=prefer\" -tAc 'select 1' | grep -qx 1",
        "libpq accepts only disable, allow, prefer, require, verify-ca and verify-full, spelled with hyphens. verify_full is rejected while the client parses the connection string, before any connection is attempted.",
        ("Use one of the accepted values exactly: verify-full for certificate checking, or prefer and require when the server has no certificate.", "Check the same string in PGSSLMODE and in any service file.", "Note that the cluster here has no SSL, so require fails with server does not support SSL; prefer falls back to plain TCP."),
        ("postgresql", "libpq", "sslmode", "connection-string"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "psql-database-does-not-exist", "postgres:15.5", POSTGRES, "configuration", "database does not exist",
        "psql reports FATAL: database appdb does not exist: the server accepts the role, but the named database was never created on this cluster.",
        "An application script connects with -d appdb on a fresh cluster.",
        _pg_up(),
        "psql -h 127.0.0.1 -U postgres -d appdb -tAc 'select 1'",
        ("psql -h 127.0.0.1 -U postgres -d APPDB -tAc 'select 1'", "psql -h /tmp/pgsock -U postgres -d appdb -tAc 'select 1'"),
        "runuser -u postgres -- createdb -h /tmp/pgsock appdb",
        "psql -h 127.0.0.1 -U postgres -d appdb -tAc 'select 1' | grep -qx 1",
        "The server accepted the user and only the named database is missing. Postgres does not create a database on connect; CREATE DATABASE (or createdb) has to run first.",
        ("Check the database name in the script or the connection string against the one that exists: psql -l.", "Create it with createdb as a role allowed to create databases, or point the client at an existing one.", "Verify the connection to the named database with psql -d."),
        ("postgresql", "psql", "createdb", "configuration"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "psql-role-does-not-exist", "postgres:15.5", POSTGRES, "configuration", "role does not exist",
        "psql reports FATAL: role app does not exist because the cluster was initialised with only the postgres role and the client connects as app.",
        "A deployment that connects as role app on a new cluster.",
        _pg_up(),
        "psql -h 127.0.0.1 -U app -d postgres -tAc 'select 1'",
        ("psql -h 127.0.0.1 -U APP -d postgres -tAc 'select 1'", "psql -h /tmp/pgsock -U app -d postgres -tAc 'select 1'"),
        "runuser -u postgres -- createuser -h /tmp/pgsock app",
        "psql -h 127.0.0.1 -U app -d postgres -tAc 'select 1' | grep -qx 1",
        "Authentication is decided per role, and the role must exist in pg_authid before any rule can match it. The cluster was initialised with only the postgres role, so the connection for app stops with role does not exist.",
        ("List the roles with psql -c '\\du' as the postgres superuser, and compare the name with the one the client sends.", "Create the role with createuser (add --superuser or grants only if the application needs them).", "Verify the connection with psql -U <role>."),
        ("postgresql", "psql", "role", "configuration"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "psql-pg-hba-rejects-host", "postgres:15.5", POSTGRES, "configuration", "pg_hba.conf rejects connection",
        "psql reports that pg_hba.conf rejects the connection for host 127.0.0.1, because the host line for that address in the authentication file is set to reject.",
        "A local cluster generated with the host authentication method set to reject, so TCP clients are refused while socket clients still work.",
        _pg_up(auth_host="reject"),
        PG_TCP,
        ("psql -h localhost -U postgres -w -tAc 'select 1'", "psql -h 127.0.0.1 -U postgres -tAc 'select 1' -v ON_ERROR_STOP=1"),
        r"sed -i -E 's#^(host.*127\.0\.0\.1/32.*)reject#\1trust#' /tmp/pgdata/pg_hba.conf && runuser -u postgres -- pg_ctl -D /tmp/pgdata reload >/dev/null && sleep 1",
        PG_TCP + " | grep -qx 1",
        "pg_hba.conf is read top to bottom and the first matching line decides. The host line for 127.0.0.1/32 says reject, so the server refuses the TCP connection before it asks for anything. The local socket line is separate, which is why socket connections still work.",
        ("Read the matching line of pg_hba.conf for the client address and database, and check which method it uses.", "Change the method to one the deployment intends (scram-sha-256 with a credential the operator provides, or trust on a closed network), then reload the configuration.", "Reloading with pg_ctl reload or SELECT pg_reload_conf() is enough; no restart is needed."),
        ("postgresql", "pg_hba", "authentication", "configuration"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "sqlite-database-locked-stale-writer", "python:3.12.4", PYTHON, "tooling", "database is locked",
        "A Python script cannot write to a SQLite file because another process holds an exclusive transaction that was never committed or rolled back.",
        "A worker that started a BEGIN EXCLUSIVE and stalled, while a second script tries to insert a row into the same database file.",
        """mkdir -p /w && python3 -c "import sqlite3; c=sqlite3.connect('/w/app.db'); c.execute('create table if not exists t(x)'); c.commit()" && (python3 -c "import sqlite3,os,time; c=sqlite3.connect('/w/app.db', isolation_level=None); c.execute('BEGIN EXCLUSIVE'); open('/w/holder.pid','w').write(str(os.getpid())); time.sleep(300)" >/dev/null 2>&1 &) && sleep 1""",
        """cd /w && python3 -c "import sqlite3; c=sqlite3.connect('/w/app.db'); c.execute('insert into t values (1)'); c.commit(); print('insert ok')\"""",
        (
            """cd /w && python3 -c "import sqlite3; c=sqlite3.connect('/w/app.db'); print(c.execute('select count(*) from t').fetchone())\"""",
            """cd /w && python3 -c "import sqlite3; c=sqlite3.connect('/w/app.db', timeout=0); c.execute('insert into t values (2)'); c.commit()\"""",
        ),
        "kill $(cat /w/holder.pid) && sleep 1",
        """cd /w && python3 -c "import sqlite3; c=sqlite3.connect('/w/app.db'); c.execute('insert into t values (3)'); c.commit(); print('insert ok')" | grep -qx 'insert ok'""",
        "SQLite allows one writer at a time, and an EXCLUSIVE transaction also blocks readers. Another process still holds one because its transaction was never committed or rolled back. The client waits only for its busy timeout (5 seconds by default in Python) and then fails with database is locked.",
        ("Find the process holding the file: lsof or fuser on the database path, or the pid the worker wrote to its own pid file.", "Stop that process cleanly, or let it commit or roll back, so the lock is released.", "Keep transactions short; a writer that stalls while holding BEGIN EXCLUSIVE blocks every other connection."),
        ("python", "sqlite", "locking", "transaction"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "sqlite-unable-to-open-missing-directory", "python:3.12.4", PYTHON, "configuration", "unable to open database file",
        "A service creates its SQLite database under /var/lib/appdata, a directory the image never created.",
        "Starting a Python script in a fresh container whose data directory was only referenced in its configuration.",
        "",
        """python3 -c "import sqlite3; c=sqlite3.connect('/var/lib/appdata/app.db'); c.execute('create table if not exists t(x)'); c.commit(); print('db ready')\"""",
        (
            """python3 -c "import sqlite3; sqlite3.connect('file:/var/lib/appdata/app.db?mode=rw', uri=True)\"""",
            "ls -ld /var/lib/appdata 2>&1",
        ),
        "mkdir -p /var/lib/appdata",
        """python3 -c "import sqlite3; c=sqlite3.connect('/var/lib/appdata/app.db'); c.execute('create table if not exists t(x)'); c.commit(); print('db ready')" | grep -qx 'db ready'""",
        "sqlite3 creates the database file but not the directories above it. When /var/lib/appdata does not exist, the open call fails with SQLITE_CANTOPEN, which Python reports as unable to open database file.",
        ("Check that the parent directory of the database path exists and is writable by the process: ls -ld on it.", "Create the directory in the image or in the entrypoint, with the owner the service runs as.", "A path that is a directory, or an URI with mode=rw on a missing file, fails with the same message."),
        ("python", "sqlite", "path", "configuration"),
        ecosystem="databases", written_by_model="claude-haiku-5-5",
    ),
)
