-- Sign-up now asks for the owner's WhatsApp number, and that is how Aiden
-- recognises them when they write to him, so it must land on the profile.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, phone)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    new.email,
    nullif(new.raw_user_meta_data->>'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
