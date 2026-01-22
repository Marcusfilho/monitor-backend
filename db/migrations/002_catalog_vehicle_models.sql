create table if not exists catalog_vehicle_models (
  model_key         text primary key,        -- chave normalizada
  vehicle_type_id   int not null,
  friendly_name     text,                    -- nome fácil pro instalador
  vehicle_type_raw  text,                    -- seu "vehicle type" original
  tags              jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  updated_by        text
);

create table if not exists catalog_vehicle_model_aliases (
  alias_key   text primary key,
  model_key   text not null references catalog_vehicle_models(model_key) on delete cascade,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
