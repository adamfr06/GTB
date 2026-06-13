create or replace function public.append_game_question(p_game_id text, p_question jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_questions jsonb;
begin
  update public.games
  set questions = questions || jsonb_build_array(p_question)
  where id = p_game_id
    and status = 'playing'
    and jsonb_array_length(questions) < 20
  returning questions into updated_questions;

  if updated_questions is null then
    raise exception 'game_not_updateable';
  end if;

  return updated_questions;
end;
$$;

revoke all on function public.append_game_question(text, jsonb) from public;
revoke all on function public.append_game_question(text, jsonb) from anon;
revoke all on function public.append_game_question(text, jsonb) from authenticated;
grant execute on function public.append_game_question(text, jsonb) to service_role;
