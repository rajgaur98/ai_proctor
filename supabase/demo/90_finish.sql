-- Demo seed (#351), last step: drop the scratch schema and print what was made.

drop schema demo cascade;

\echo
\echo 'Rows per table'
select t.table_name as "table", (xpath('/row/n/text()',
  query_to_xml(format('select count(*) as n from public.%I', t.table_name), false, true, '')))[1]::text::int as "rows"
from information_schema.tables t
where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
order by 1;

\echo 'Live status now (Team grid)'
select p.status, count(*) as people, string_agg(split_part(u.full_name, ' ', 1), ', ' order by u.full_name) as who
from public.presence p join public.users u on u.id = p.user_id
where u.active
group by p.status
order by count(*) desc, p.status;

\echo 'Timesheets by state'
select status, count(*) from public.timesheets group by 1 order by 1;
