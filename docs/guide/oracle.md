# Oracle

The Oracle plugin connects to Oracle Database 12.1 or later in thin mode: nothing else to install,
no Instant Client. It [downloads the first time you add an Oracle data
source](plugins.md#databases-in-the-box-and-on-demand). Schemas list in the Database pane, and the
console runs SQL and PL/SQL.

## Connect

1. In **Connect by**, pick **Service name** or **SID**.
2. Type the service name or SID in **Service**.
3. Optionally, pick a **Role**: SYSDBA, SYSOPER or SYSBACKUP.
4. For SSL, set **SSL mode** to _Verify CA_ or _Verify full_ and give the server's CA file in **SSL
   root certificate**. The connection then goes over TCPS.

Or paste `oracle://user@host:1521/FREEPDB1` to fill the form in.

## Schemas

Schemas are the tree's namespaces, yours first and Oracle-maintained ones under System. Packages list
their members as `PACKAGE.MEMBER`, one row per overload.

`ALTER SESSION SET CURRENT_SCHEMA` moves the console and its completion to that schema.

## Values

- `NUMBER` keeps every digit. A `NUMBER(p)` column is an integer, and `NUMBER(p,s)` a decimal padded
  to its scale.
- `DATE` shows its time.
- `CLOB` reads as text, and as JSON when it has an `IS JSON` check.
- `BLOB` and `RAW` read as bytes.
- Oracle stores `''` as NULL, so an empty cell you submit reads back as NULL.

## Scripts

A PL/SQL block ends at a `/` line and keeps its `;`. A plain statement loses its trailing `;` before
it is sent.

`DBMS_OUTPUT.PUT_LINE` lines show in Output after each statement. A procedure that compiles with
errors lists them, with line and column, as warnings.

## Transactions

Oracle commits each DDL statement on its own, so `CREATE TABLE` in a manual transaction commits what
came before it. The table designer says so before it runs.

## Completion

Completion offers every function of the _SQL Functions_ chapter for the server's version: `SYSDATE`
without parentheses, `EXTRACT(YEAR FROM …)` with its argument in bold. After `pkg.`, it offers the
members of `DBMS_OUTPUT`, `DBMS_LOB`, `DBMS_STATS`, `UTL_RAW` and other supplied packages.

## Sessions

Listing other sessions needs `SELECT_CATALOG_ROLE`, and cancelling or killing them needs
`ALTER SYSTEM`. Without them, the tab lists your own session and says what to ask for.

## Limits

- Oracle Database versions before 12.1 are not supported.
- SSL has no _Require_ mode, because thin mode always checks the certificate.

See [Oracle](../design/specification.md#oracle).
