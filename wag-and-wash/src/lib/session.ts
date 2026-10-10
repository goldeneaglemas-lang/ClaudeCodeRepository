// Reading the signed-in customer inside server pages (API routes use the request instead).
import { cookies } from "next/headers";
import { getAccount } from "./account";
import { SESSION_COOKIE, phoneForToken } from "./auth";

export async function currentPhone(): Promise<string | null> {
  return phoneForToken((await cookies()).get(SESSION_COOKIE)?.value);
}

export type Me = {
  phone: string;
  name: string;
  email: string;
  smsOptIn: boolean;
  dogs: { id: string; name: string; breed: string | null; size: string; notes: string | null }[];
};

export async function currentCustomer(): Promise<Me | null> {
  const phone = await currentPhone();
  if (!phone) return null;
  const account = await getAccount(phone);
  return {
    phone,
    name: account?.name ?? "",
    email: account?.email ?? "",
    smsOptIn: account?.smsOptIn ?? true,
    dogs: (account?.dogs ?? []).map((d) => ({ id: d.id, name: d.name, breed: d.breed, size: d.size, notes: d.notes })),
  };
}
