import clsx, { type ClassValue } from 'clsx';

/**
 * Class-name join. Deliberately not `tailwind-merge`: every component below
 * puts its variant classes in one place and appends `className` last, so
 * conflicting utilities do not arise and a 6 kB merge library is not earned.
 */
export function cn(...values: ClassValue[]): string {
  return clsx(values);
}
