-- #335 (API-06, AUD-01): webhook test events, redelivery, and a grace period after a secret
-- is rotated. Builds on 20261105700000_webhooks_and_time_off_api.sql (#320).
--
-- Test event: send_test_webhook(endpoint) queues a `ping` event for that one endpoint
-- ({ id, type: "ping", created_at, api_version, data: { webhook_id } }), signed and sent by
-- deliver-webhooks like any other event (same retries; a ping that fails every attempt
-- counts as a failed delivery). The endpoint must be on. At most 10 per endpoint an hour.
--
-- Redeliver: redeliver_webhook(delivery) queues the same event again (same event id,
-- type, created_at and data: the receiver dedupes on the id) as a new delivery whose
-- redelivery_of names the one it repeats. Only a delivered or failed delivery, only while
-- its endpoint is on, and not while a copy of that event to that endpoint still waits.
-- A delivery's event id is unique per endpoint only among original deliveries
-- (webhook_emit's dedupe); redeliveries are extra rows.
--
-- Both are audit-logged (webhook.test_sent, webhook.redelivered) and ask deliver-webhooks
-- to run at once (webhooks_kick, as the cron job does every minute), so the result shows
-- in the log within seconds.
--
-- Rotation grace period: rotate_webhook_secret keeps the secret it replaces in Vault as
-- webhook_secret_prev:<id> for 24 hours (previous_secret_expires_at). While it lasts,
-- webhook_claim hands it out too and deliver-webhooks sends two signatures,
-- "v1=<new>,v1=<previous>", so a receiver that still has the old secret keeps accepting
-- events while it is updated. Rotating again within the 24 hours replaces the previous
-- secret with the one just retired (only one previous secret is ever kept). The
-- webhooks_end_grace job (every minute) removes it from Vault when the 24 hours are up;
-- deleting the endpoint (or its org) removes it at once (webhooks_forget_secret).
--
-- Redefined here, each copied from its latest definition (20261105700000) with only the
-- changes above:
--   internal.webhook_emit            on conflict names the partial unique index
--   internal.webhooks_forget_secret  also deletes the previous secret
--   public.rotate_webhook_secret     keeps the previous secret for 24 hours
--   public.list_webhooks             + previous_secret_expires_at (return type: dropped first)
--   public.list_webhook_deliveries   + redelivery_of (return type: dropped first)
--   public.webhook_claim             + previous_secret (return type: dropped first)

-- Columns -------------------------------------------------------------------------------------

alter table public.webhooks add column previous_secret_expires_at timestamptz;
comment on column public.webhooks.previous_secret_expires_at is
  'Until when deliveries are also signed with the secret a rotation replaced (#335); null: none.';

-- Ending the grace period isn't a change anyone made: it doesn't move updated_at.
drop trigger webhooks_touch_updated_at on public.webhooks;
create trigger webhooks_touch_updated_at before update on public.webhooks
  for each row execute function internal.touch_updated_at('failed_in_row', 'previous_secret_expires_at');

-- Not a foreign key: the delivery it repeats may be deleted first (a deleted person's
-- delivered events go; both are purged after 30 days).
alter table public.webhook_deliveries add column redelivery_of uuid;
comment on column public.webhook_deliveries.redelivery_of is
  'The delivery this one sends again (an admin''s Redeliver, #335); null for an original.';

alter table public.webhook_deliveries drop constraint webhook_deliveries_once;
create unique index webhook_deliveries_once on public.webhook_deliveries (webhook_id, event_id)
  where redelivery_of is null;

-- Helpers -------------------------------------------------------------------------------------

create function internal.webhook_previous_secret_name(p_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$ select 'webhook_secret_prev:' || p_id::text $$;
revoke all on function internal.webhook_previous_secret_name(uuid) from public, anon, authenticated;

-- Queues one event for every enabled endpoint of the org that wants it. The same event id
-- twice for an endpoint is queued once.
create or replace function internal.webhook_emit(
  p_org_id uuid,
  p_type text,
  p_event_id uuid,
  p_subject_user_id uuid,
  p_data jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.webhook_deliveries (org_id, webhook_id, event_id, event_type,
    subject_user_id, payload)
  select p_org_id, w.id, p_event_id, p_type, p_subject_user_id,
    jsonb_build_object('id', p_event_id, 'type', p_type, 'created_at', now(),
      'api_version', 'v1', 'data', p_data)
  from public.webhooks w
  where w.org_id = p_org_id and w.enabled and p_type = any (w.events)
  on conflict (webhook_id, event_id) where redelivery_of is null do nothing;
$$;

-- An endpoint's secrets leave Vault with it, also when its org is deleted.
create or replace function internal.webhooks_forget_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets s
  where s.name in (internal.webhook_secret_name(old.id), internal.webhook_previous_secret_name(old.id));
  return old;
end;
$$;

-- Rotation ------------------------------------------------------------------------------------

-- A new signing secret, returned once. For 24 hours deliveries are signed with it and with
-- the secret it replaces (see the header), then with the new one only.
create or replace function public.rotate_webhook_secret(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_row public.webhooks;
  v_secret text := internal.webhook_new_secret();
  v_vault uuid;
  v_old text;
  v_prev uuid;
  v_until timestamptz := now() + interval '24 hours';
begin
  select * into v_row from public.webhooks w where w.id = p_id and w.org_id = v_me.org_id for update;
  if not found then
    raise exception 'webhook_not_found' using errcode = '42501';
  end if;
  select s.id, s.decrypted_secret into v_vault, v_old
  from vault.decrypted_secrets s where s.name = internal.webhook_secret_name(v_row.id);

  if v_old is not null then
    select s.id into v_prev from vault.secrets s
    where s.name = internal.webhook_previous_secret_name(v_row.id);
    if v_prev is null then
      perform vault.create_secret(v_old, internal.webhook_previous_secret_name(v_row.id),
        'Previous signing secret of a webhook endpoint, kept 24 hours after a rotation (#335)');
    else
      perform vault.update_secret(v_prev, v_old);
    end if;
  else
    delete from vault.secrets s where s.name = internal.webhook_previous_secret_name(v_row.id);
    v_until := null;
  end if;

  if v_vault is null then
    perform vault.create_secret(v_secret, internal.webhook_secret_name(v_row.id),
      'Signing secret of a webhook endpoint (#320)');
  else
    perform vault.update_secret(v_vault, v_secret);
  end if;
  update public.webhooks
  set secret_rotated_at = now(), previous_secret_expires_at = v_until
  where id = v_row.id;
  perform internal.audit(v_me.org_id, v_me.id, 'webhook.secret_rotated', null,
    jsonb_build_object('webhook_id', v_row.id, 'host', internal.webhook_host(v_row.url),
      'previous_valid_until', v_until));
  return v_secret;
end;
$$;

-- Removes previous secrets whose 24 hours are up (cron webhooks_end_grace, every minute).
-- webhook_claim stops handing one out at the expiry itself, whenever this runs.
create function internal.webhooks_end_grace()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  with ended as (
    update public.webhooks w set previous_secret_expires_at = null
    where w.previous_secret_expires_at <= now()
    returning w.id
  )
  delete from vault.secrets s using ended
  where s.name = internal.webhook_previous_secret_name(ended.id);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function internal.webhooks_end_grace() from public, anon, authenticated;

select cron.schedule('webhooks_end_grace', '* * * * *', 'select internal.webhooks_end_grace()');

-- Test event and redelivery ---------------------------------------------------------------------

-- Queues a ping for one endpoint and returns the delivery's id.
create function public.send_test_webhook(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_row public.webhooks;
  v_event uuid := gen_random_uuid();
  v_delivery uuid;
begin
  select * into v_row from public.webhooks w where w.id = p_id and w.org_id = v_me.org_id for update;
  if not found then
    raise exception 'webhook_not_found' using errcode = '42501';
  end if;
  if not v_row.enabled then
    raise exception 'webhook_off' using errcode = '22023';
  end if;
  if (
    select count(*) from public.webhook_deliveries d
    where d.webhook_id = v_row.id and d.event_type = 'ping'
      and d.created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'too_many_tests' using errcode = '22023';
  end if;

  insert into public.webhook_deliveries (org_id, webhook_id, event_id, event_type, payload)
  values (v_row.org_id, v_row.id, v_event, 'ping',
    jsonb_build_object('id', v_event, 'type', 'ping', 'created_at', now(), 'api_version', 'v1',
      'data', jsonb_build_object('webhook_id', v_row.id)))
  returning id into v_delivery;

  perform internal.audit(v_me.org_id, v_me.id, 'webhook.test_sent', null,
    jsonb_build_object('webhook_id', v_row.id, 'host', internal.webhook_host(v_row.url),
      'event_id', v_event, 'delivery_id', v_delivery));
  perform internal.webhooks_kick();
  return v_delivery;
end;
$$;

-- Queues a delivered or failed delivery's event again, to the same endpoint, and returns the
-- new delivery's id.
create function public.redeliver_webhook(p_delivery_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_d public.webhook_deliveries;
  v_w public.webhooks;
  v_delivery uuid;
begin
  select * into v_d from public.webhook_deliveries d
  where d.id = p_delivery_id and d.org_id = v_me.org_id;
  if not found then
    raise exception 'delivery_not_found' using errcode = '42501';
  end if;
  -- One at a time per endpoint, so two can't both pass the check below.
  select * into v_w from public.webhooks w where w.id = v_d.webhook_id for update;
  if not v_w.enabled then
    raise exception 'webhook_off' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.webhook_deliveries d
    where d.webhook_id = v_d.webhook_id and d.event_id = v_d.event_id and d.status = 'pending'
  ) then
    raise exception 'delivery_pending' using errcode = '22023';
  end if;

  insert into public.webhook_deliveries (org_id, webhook_id, event_id, event_type,
    subject_user_id, payload, redelivery_of)
  values (v_d.org_id, v_d.webhook_id, v_d.event_id, v_d.event_type, v_d.subject_user_id,
    v_d.payload, v_d.id)
  returning id into v_delivery;

  perform internal.audit(v_me.org_id, v_me.id, 'webhook.redelivered', null,
    jsonb_build_object('webhook_id', v_w.id, 'host', internal.webhook_host(v_w.url),
      'event_id', v_d.event_id, 'event_type', v_d.event_type, 'delivery_id', v_delivery,
      'redelivery_of', v_d.id));
  perform internal.webhooks_kick();
  return v_delivery;
end;
$$;

revoke all on function public.send_test_webhook(uuid) from public, anon;
revoke all on function public.redeliver_webhook(uuid) from public, anon;
grant execute on function public.send_test_webhook(uuid) to authenticated;
grant execute on function public.redeliver_webhook(uuid) to authenticated;

-- Lists -----------------------------------------------------------------------------------------

drop function public.list_webhooks();

-- The org's endpoints, oldest first, with their latest delivery. Never the secret.
-- previous_secret_expires_at: while the replaced secret still signs too.
create function public.list_webhooks()
returns table (
  id uuid,
  url text,
  events text[],
  enabled boolean,
  disabled_reason text,
  disabled_at timestamptz,
  failed_in_row int,
  created_at timestamptz,
  created_by_name text,
  secret_rotated_at timestamptz,
  previous_secret_expires_at timestamptz,
  last_delivery_at timestamptz,
  last_delivery_status text,
  pending int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
begin
  return query
  select w.id, w.url, w.events, w.enabled, w.disabled_reason, w.disabled_at, w.failed_in_row,
    w.created_at, u.full_name, w.secret_rotated_at,
    case when w.previous_secret_expires_at > now() then w.previous_secret_expires_at end,
    last.created_at, last.status,
    (select count(*)::int from public.webhook_deliveries d
     where d.webhook_id = w.id and d.status = 'pending')
  from public.webhooks w
  left join public.users u on u.id = w.created_by
  left join lateral (
    select d.created_at, d.status from public.webhook_deliveries d
    where d.webhook_id = w.id order by d.created_at desc, d.id limit 1
  ) last on true
  where w.org_id = v_me.org_id
  order by w.created_at, w.id;
end;
$$;

drop function public.list_webhook_deliveries(uuid, int);

-- The delivery log, newest first: one endpoint's or all (p_webhook_id null), at most 500.
-- next_attempt_at only while a delivery is waiting for its next attempt; redelivery_of when
-- it sends an earlier delivery's event again.
create function public.list_webhook_deliveries(p_webhook_id uuid default null, p_limit int default 100)
returns table (
  id uuid,
  webhook_id uuid,
  url text,
  event_id uuid,
  event_type text,
  status text,
  attempts int,
  response_status int,
  last_error text,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz,
  redelivery_of uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
begin
  return query
  select d.id, d.webhook_id, w.url, d.event_id, d.event_type, d.status, d.attempts,
    d.response_status, d.last_error,
    case when d.status = 'pending' then d.next_attempt_at end,
    d.last_attempt_at, d.delivered_at, d.created_at, d.redelivery_of
  from public.webhook_deliveries d
  join public.webhooks w on w.id = d.webhook_id
  where d.org_id = v_me.org_id
    and (p_webhook_id is null or d.webhook_id = p_webhook_id)
  order by d.created_at desc, d.id
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

revoke all on function public.list_webhooks() from public, anon;
revoke all on function public.list_webhook_deliveries(uuid, int) from public, anon;
grant execute on function public.list_webhooks() to authenticated;
grant execute on function public.list_webhook_deliveries(uuid, int) to authenticated;

-- Delivery ---------------------------------------------------------------------------------------

drop function public.webhook_claim(int);

-- Hands out up to p_limit due deliveries of enabled endpoints, counting the attempt and
-- setting when the next one is due, so overlapping runs never take the same row and an
-- attempt whose result is never recorded is retried. With each: the endpoint's URL and
-- secret, the previous secret while its grace period lasts, and whether private hosts are
-- allowed (local stacks).
create function public.webhook_claim(p_limit int default 25)
returns table (
  id uuid,
  url text,
  secret text,
  previous_secret text,
  payload jsonb,
  event_type text,
  event_id uuid,
  attempt int,
  allow_private boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An attempt whose result never came back: after the last one, the delivery has failed.
  update public.webhook_deliveries d
  set status = 'failed', last_error = coalesce(d.last_error, 'no result recorded')
  where d.status = 'pending' and d.attempts >= internal.webhook_max_attempts()
    and d.next_attempt_at <= now();

  return query
  with claimed as (
    update public.webhook_deliveries d
    set attempts = d.attempts + 1,
        last_attempt_at = now(),
        next_attempt_at = now() + internal.webhook_backoff(d.attempts + 1)
    where d.id in (
      select q.id from public.webhook_deliveries q
      join public.webhooks w on w.id = q.webhook_id and w.enabled
      where q.status = 'pending' and q.attempts < internal.webhook_max_attempts()
        and q.next_attempt_at <= now()
      order by q.next_attempt_at
      limit least(greatest(coalesce(p_limit, 25), 1), 100)
      for update of q skip locked
    )
    returning d.*
  )
  select c.id, w.url, s.decrypted_secret,
    case when w.previous_secret_expires_at > now() then p.decrypted_secret end,
    c.payload, c.event_type, c.event_id, c.attempts,
    internal.webhooks_allow_private_hosts()
  from claimed c
  join public.webhooks w on w.id = c.webhook_id
  left join vault.decrypted_secrets s on s.name = internal.webhook_secret_name(w.id)
  left join vault.decrypted_secrets p on p.name = internal.webhook_previous_secret_name(w.id);
end;
$$;

revoke all on function public.webhook_claim(int) from public, anon, authenticated;
grant execute on function public.webhook_claim(int) to service_role;
