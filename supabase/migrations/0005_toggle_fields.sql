-- Toggle fields (kind 'toggle', stored as a boolean).
--
-- Redefines api_coerce from 0004 so api_set_field / api_update_item /
-- api_create_item accept toggle values: true/false, a number (non-zero = on)
-- or a yes/no-ish word, mirroring parseToggle in src/model/fields.ts.

/**
 * Validate and normalise a value for a field, mirroring src/model/fields.ts:
 * text → string, int/float → number, toggle → boolean, select → array of
 * option strings, ref → array of existing item/section ids. Returns null for "unset".
 */
create or replace function public.api_coerce(p_doc jsonb, p_field jsonb, p_value jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  kind text := p_field->>'kind';
  fname text := coalesce(p_field->>'name', p_field->>'id');
  s text; n numeric; arr jsonb; el jsonb; bad text; tgt record;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then return null; end if;
  case kind
    when 'text' then
      if jsonb_typeof(p_value) not in ('string', 'number') then
        raise exception 'Field "%" expects a string', fname;
      end if;
      s := p_value #>> '{}';
      if s = '' then return null; end if;
      if (p_field->>'maxLength') is not null and length(s) > (p_field->>'maxLength')::int then
        raise exception 'Field "%" allows at most % characters', fname, p_field->>'maxLength';
      end if;
      return to_jsonb(s);
    when 'toggle' then
      if jsonb_typeof(p_value) = 'boolean' then return p_value; end if;
      if jsonb_typeof(p_value) = 'number' then return to_jsonb((p_value #>> '{}')::numeric <> 0); end if;
      if jsonb_typeof(p_value) = 'string' then
        s := lower(trim(p_value #>> '{}'));
        if s = '' then return null; end if;
        if s in ('true', 'yes', 'y', 'on', '1', 'x') then return to_jsonb(true); end if;
        if s in ('false', 'no', 'n', 'off', '0') then return to_jsonb(false); end if;
      end if;
      raise exception 'Field "%" expects true or false', fname;
    when 'int', 'float' then
      if jsonb_typeof(p_value) <> 'number' then raise exception 'Field "%" expects a number', fname; end if;
      n := (p_value #>> '{}')::numeric;
      if kind = 'int' and n <> trunc(n) then raise exception 'Field "%" expects a whole number', fname; end if;
      if (p_field->>'min') is not null and n < (p_field->>'min')::numeric then
        raise exception 'Field "%" must be at least %', fname, p_field->>'min';
      end if;
      if (p_field->>'max') is not null and n > (p_field->>'max')::numeric then
        raise exception 'Field "%" must be at most %', fname, p_field->>'max';
      end if;
      return p_value;
    when 'select', 'ref' then
      if jsonb_typeof(p_value) = 'string' then arr := jsonb_build_array(p_value);
      elsif jsonb_typeof(p_value) = 'array' then arr := p_value;
      else raise exception 'Field "%" expects a string or an array of strings', fname;
      end if;
      if jsonb_array_length(arr) = 0 then return null; end if;
      for el in select * from jsonb_array_elements(arr) loop
        if jsonb_typeof(el) <> 'string' then raise exception 'Field "%" expects strings', fname; end if;
      end loop;
      if kind = 'select' then
        select e #>> '{}' into bad from jsonb_array_elements(arr) e
          where not coalesce(p_field->'options', '[]'::jsonb) ? (e #>> '{}') limit 1;
        if bad is not null then
          raise exception '"%" is not an option of field "%" (options: %)', bad, fname,
            (select string_agg(o #>> '{}', ', ') from jsonb_array_elements(coalesce(p_field->'options', '[]'::jsonb)) o);
        end if;
        if not coalesce((p_field->>'selectMultiple')::boolean, false) and jsonb_array_length(arr) > 1 then
          raise exception 'Field "%" accepts a single option', fname;
        end if;
      else
        for el in select * from jsonb_array_elements(arr) loop
          select * into tgt from public.api_entity(p_doc, el #>> '{}');
          if jsonb_array_length(coalesce(p_field->'refTargets', '[]'::jsonb)) > 0 then
            if not (p_field->'refTargets' ? (case when tgt.col = 'items' then tgt.entity->>'typeId'
                else p_doc->'hierarchyLevels'->((tgt.entity->>'depth')::int)->>'id' end)) then
              raise exception 'Field "%" cannot reference "%" (not an allowed target)', fname, coalesce(tgt.entity->>'title', tgt.entity->>'name', el #>> '{}');
            end if;
          end if;
        end loop;
        if not coalesce((p_field->>'refMultiple')::boolean, false) and jsonb_array_length(arr) > 1 then
          raise exception 'Field "%" accepts a single reference', fname;
        end if;
      end if;
      return arr;
    else
      raise exception 'Field "%" has unsupported kind "%"', fname, kind;
  end case;
end $$;
