-- #308 (DSH-11): a big org for the seat map's performance check. Seeds `people` synthetic
-- employees (default 5000) reporting to Max Manager, in teams of mixed sizes (3 to 130, so
-- some spill onto more tables), with a mix of statuses, and commits them so the dashboard
-- can read them. `remove=1` deletes them again. Run it with scripts/it-seat-map-scale.sh,
-- never against production.
--   psql "$DB_URL" -X -v people=5000 -f scripts/it-seat-map-scale.sql
--   psql "$DB_URL" -X -v remove=1 -f scripts/it-seat-map-scale.sql
\set ON_ERROR_STOP on
\if :{?people}
\else
  \set people 5000
\endif
\if :{?remove}
\else
  \set remove 0
\endif
set client_min_messages = warning;

\set org '''00000000-0000-4000-8000-000000000001'''
\set max '''00000000-0000-4000-8000-0000000000b1'''

begin;
-- Whatever an earlier run left behind (users first: their team is a foreign key).
delete from auth.users where email like 'seat%@seat-scale.test';
delete from public.teams where org_id = :org and name like 'Seat scale %';
commit;

\if :remove
  \echo removed the seat map scale org
  \quit
\endif

begin;
-- Team sizes cycle through these, so the map has small, long and split tables.
create temp table seat_sizes (i int, size int);
insert into seat_sizes
select row_number() over () - 1, s
from unnest(array[3, 7, 12, 18, 25, 33, 40, 48, 60, 75, 130, 9, 22]) s;

-- Enough teams for everyone: team t holds people [start, start + size).
create temp table seat_teams as
with recursive t (n, start) as (
  select 0, 1
  union all
  select n + 1, start + (select size from seat_sizes where i = n % 13)
  from t
  where start + (select size from seat_sizes where i = n % 13) <= :people
)
select gen_random_uuid() as id, n, start,
  'Seat scale ' || lpad((n + 1)::text, 3, '0') as name
from t;

insert into public.teams (id, org_id, name)
select id, :org, name from seat_teams;

create temp table seat_users as
select gen_random_uuid() as id, g as n,
  (select id from seat_teams where start <= g order by start desc limit 1) as team_id
from generate_series(1, :people) g;

insert into auth.users (id, email) select id, 'seat' || n || '@seat-scale.test' from seat_users;
insert into public.users (id, org_id, full_name, email, role, manager_id, active, timezone, team_id)
select id, :org, 'Seat Person ' || lpad(n::text, 4, '0'), 'seat' || n || '@seat-scale.test',
  'employee', :max, true, 'America/Los_Angeles', team_id
from seat_users;

-- About half active, the rest spread over the other statuses.
insert into public.presence (user_id, org_id, status, since)
select id, :org,
  (case when n % 2 = 0 then 'active'
        else (array['idle', 'away', 'away_locked', 'on_break', 'paused', 'in_meeting', 'offline',
                    'off_shift'])[1 + (n / 2) % 8] end)::public.presence_status,
  now() - (n % 180) * interval '1 minute'
from seat_users;

analyze public.users, public.presence, public.teams;
commit;

select (select count(*) from seat_users) as people, (select count(*) from seat_teams) as teams;
