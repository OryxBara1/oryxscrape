revoke all on function public.is_staff(uuid) from public;
revoke all on function public.is_staff_owner(uuid) from public;
grant execute on function public.is_staff(uuid) to authenticated, service_role;
grant execute on function public.is_staff_owner(uuid) to authenticated, service_role;