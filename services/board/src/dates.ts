// Calendar dates (YYYY-MM-DD) and weekdays: the board's day maths (workdays, scheduled moves).
export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const DATE = /^\d{4}-\d{2}-\d{2}$/;

const toUtc = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUtc = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (date: string, n: number) => fromUtc(new Date(toUtc(date).getTime() + n * 86_400_000));
export const weekdayOf = (date: string): Weekday => WEEKDAYS[(toUtc(date).getUTCDay() + 6) % 7]!;
/** The first workday after `date` (Friday → Monday with the default Monday to Friday week). */
export function nextWorkday(date: string, workdays: readonly Weekday[]): string {
  for (let n = 1; n <= 7; n++) if (workdays.includes(weekdayOf(addDays(date, n)))) return addDays(date, n);
  return addDays(date, 1);
}
