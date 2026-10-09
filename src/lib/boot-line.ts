/**
 * 拍手 2 回で起動したときの一言。時間帯であいさつを変える。
 *   4:00〜11:59 Good morning ／ 12:00〜17:59 Good afternoon ／ 18:00〜3:59 Good evening
 */
export function bootLine(now: Date = new Date()): string {
  const h = now.getHours();
  const greeting = h >= 4 && h < 12 ? "Good morning" : h >= 12 && h < 18 ? "Good afternoon" : "Good evening";
  return `All systems are online. ${greeting}, sir.`;
}
