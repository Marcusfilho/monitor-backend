create table if not exists catalog_vehicle_settings (
  client_id           int not null,
  profile_key         text not null,        -- default | dallas | dmas | leve | pesado | etc
  client_name         text,
  setting_name        text,
  vehicle_setting_id  int not null,
  is_default          boolean not null default false,
  tags                jsonb not null default '{}'::jsonb,
  updated_at          timestamptz not null default now(),
  updated_by          text,
  primary key (client_id, profile_key)
);

create index if not exists idx_catalog_vehicle_settings_client
  on catalog_vehicle_settings (client_id);
