#!/bin/sh
# Runs setup.sql against a throwaway local Postgres and checks the rules it promises.
# Usage (as a non-root user with Postgres 16 binaries): sh supabase/test.sh
set -e
BIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DIR=$(mktemp -d); PORT=54329
"$BIN/initdb" -D "$DIR/db" -A trust -U postgres >/dev/null
"$BIN/pg_ctl" -D "$DIR/db" -o "-p $PORT -c listen_addresses='' -k $DIR" -w start >/dev/null
trap '"$BIN/pg_ctl" -D "$DIR/db" -m immediate stop >/dev/null; rm -rf "$DIR"' EXIT
Q() { psql -h "$DIR" -p $PORT -U "${ROLE:-postgres}" -d postgres -v ON_ERROR_STOP=1 -At -c "$1" 2>&1; }
Q "create role anon nologin; create role authenticated nologin; create role service_role nologin; create role anon_login login; grant anon to anon_login; create role svc_login login; grant service_role to svc_login" >/dev/null
psql -h "$DIR" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/setup.sql"
psql -h "$DIR" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/setup.sql"   # running it twice must be safe
for i in 1 2; do psql -h "$DIR" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/app.sql" 2>/dev/null; done
TOKEN=$(Q "select seed_new_team('pricing')")
K=$(printf 'k1' | sha256sum | cut -d' ' -f1); A1=$(printf 'first answer' | sha256sum | cut -d' ' -f1); A2=$(printf 'second answer' | sha256sum | cut -d' ' -f1)
pass=0; fail=0
check() { if echo "$2" | grep -q -- "$3"; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1: got [$2] wanted [$3]"; fi; }
ROLE=anon_login
check "token is 64 characters"                 "$(printf %s "$TOKEN" | wc -c)" "^64$"
check "nothing pinned yet returns null"        "[$(Q "select seed_get('pricing','$TOKEN','$K','alice')")]" "^\[\]$"
check "first draw is stored"                   "$(Q "select seed_put('pricing','$TOKEN','$K','42','q','haiku','first answer','$A1','alice')")" '"answer":"first answer"'
check "second draw loses, first is returned"   "$(Q "select seed_put('pricing','$TOKEN','$K','42','q','haiku','second answer','$A2','bob')")" '"answer":"first answer"'
check "teammate reads the first answer"        "$(Q "select seed_get('pricing','$TOKEN','$K','bob')")" '"drawn_by":"alice"'
check "wrong token is refused"                 "$(Q "select seed_get('pricing','nope','$K','eve')")" "unknown team or wrong token"
check "unknown team is refused"                "$(Q "select seed_get('other','$TOKEN','$K','eve')")" "unknown team or wrong token"
check "answer with a wrong fingerprint refused" "$(Q "select seed_put('pricing','$TOKEN','$K','43','q','haiku','x','$A1','alice')")" "fingerprint does not match"
check "table cannot be read directly"          "$(Q "select count(*) from seed_answers")" "permission denied"
check "team tokens cannot be read directly"    "$(Q "select * from seed_teams")" "permission denied"
check "teams cannot be created by the mod"     "$(Q "select seed_new_team('hack')")" "permission denied"
ROLE=postgres
check "only the hash of the token is stored"   "$(Q "select count(*) from seed_teams where token_hash = '$TOKEN'")" "^0$"
check "events record draw, lost race, replay"  "$(Q "select string_agg(action || ':' || who, ',' order by id) from seed_events")" "draw:alice,lost-race:bob,replay:bob"
check "exactly one answer is stored"           "$(Q "select count(*) from seed_answers")" "^1$"
NEW=$(Q "select seed_reset_token('pricing')")
ROLE=anon_login
check "a reset gives a new 64-character token"  "$(printf %s "$NEW" | wc -c)" "^64$"
check "the old token stops working"             "$(Q "select seed_get('pricing','$TOKEN','$K','alice')")" "unknown team or wrong token"
check "the new token reads the same answers"    "$(Q "select seed_get('pricing','$NEW','$K','alice')")" '"answer":"first answer"'
check "the mod cannot reset a token"            "$(Q "select seed_reset_token('pricing')")" "permission denied"
ROLE=postgres
check "resetting an unknown team is an error"   "$(Q "select seed_reset_token('nobody')")" "no team named nobody"
# ---- the web app's service functions
K2=$(printf 'k2' | sha256sum | cut -d' ' -f1); B1=$(printf 'app answer' | sha256sum | cut -d' ' -f1); B2=$(printf 'other' | sha256sum | cut -d' ' -f1)
check "an app team is created with its admin"   "$(Q "select seed_app_new_team('pricing', 'Asha@Example.com')")" "admin asha@example.com"
ROLE=svc_login
check "a member sees their teams"               "$(Q "select seed_svc_teams('ASHA@example.com')")" '"team" : "pricing", "role" : "admin"'
check "a stranger has no teams"                 "$(Q "select seed_svc_teams('eve@example.com')")" "^\[\]$"
check "a stranger cannot read"                  "$(Q "select seed_svc_get('pricing','eve@example.com','$K2')")" "not a member of this team"
check "a stranger cannot save"                  "$(Q "select seed_svc_put('pricing','eve@example.com','$K2','7','q','haiku','app answer','$B1')")" "not a member of this team"
check "nothing saved yet returns null"          "[$(Q "select seed_svc_get('pricing','asha@example.com','$K2')")]" "^\[\]$"
check "an admin can add a person"               "$(Q "select seed_svc_add_member('pricing','asha@example.com','bob@example.com')" | head -1)" "bob@example.com"
check "a non-admin cannot add people"           "$(Q "select seed_svc_add_member('pricing','bob@example.com','carol@example.com')")" "only a team admin"
check "a bad email is refused"                  "$(Q "select seed_svc_add_member('pricing','asha@example.com','not-an-email')")" "does not look like an email"
check "the first save is stored with the email" "$(Q "select seed_svc_put('pricing','asha@example.com','$K2','7','q','haiku','app answer','$B1')")" '"drawn_by":"asha@example.com"'
check "a second save loses to the first"        "$(Q "select seed_svc_put('pricing','bob@example.com','$K2','7','q','haiku','other','$B2')")" '"answer":"app answer"'
check "the list shows saved answers"            "$(Q "select json_array_length(seed_svc_list('pricing','bob@example.com'))")" "^2$"
check "members are listed"                      "$(Q "select seed_svc_members('pricing','bob@example.com')")" "asha@example.com.*bob@example.com"
ROLE=anon_login
check "the public key cannot call the service"  "$(Q "select seed_svc_list('pricing','asha@example.com')")" "permission denied"
check "the public key cannot create app teams"  "$(Q "select seed_app_new_team('x','e@example.com')")" "permission denied"
check "the /seed command sees the app's answer" "$(Q "select seed_get('pricing','$NEW','$K2','mod-user')")" '"answer":"app answer"'
ROLE=postgres
echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
