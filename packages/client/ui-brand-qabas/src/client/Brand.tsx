/**
 * The Qabas wordmark, as outlines rather than text.
 *
 * "قَبَس" is a quotation -- a borrowing of someone's exact words -- which is
 * what this product does with a lecture: it takes back what the doctor
 * actually said and builds the study material from that, rather than from a
 * paraphrase. The name is the product's claim about itself, so it is drawn
 * carefully.
 *
 * The letterforms are Reem Kufi, converted to paths at build time and checked
 * in as geometry. A desktop app cannot assume a font is installed, and an
 * Arabic wordmark that falls back to a system face is not a wordmark any more
 * -- it is different letters. Paths render identically on a machine that has
 * never seen an Arabic font, which is the machine this ships to.
 *
 * `currentColor` throughout, so the mark takes the surrounding theme without
 * a light and a dark copy.
 */

import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * The wordmark, at whatever height its host asks for.
 *
 * The brand is the whole name, not an initial: a single ق is a letter, and a
 * letter is not this product's identity. It is used at every size, including
 * the collapsed rail, where its 1.35 aspect ratio still fits.
 */
function QabasWordmark({ height, className }: { height: number | string; className?: string | undefined }) {
  return (
    <svg
      viewBox="0 0 1700 1262"
      height={height}
      className={className}
      role="img"
      aria-label="قَبَس"
      fill="currentColor"
      style={{ width: 'auto', display: 'block' }}
    >
      <g transform="translate(15, 1014) scale(1, -1)">
        <path d="M745.0 125.0 965.0 127.0V0.0H745.0ZM318.0 190.0V349.0L445.0 377.0V190.0ZM518.0 190.0V349.0L645.0 377.0V190.0ZM718.0 190.0V349.0L845.0 377.0V190.0ZM425.0 127.0H518.0V299.0L645.0 327.0V127.0H718.0V299.0L845.0 327.0V23.0Q845.0 11.0 835.0 6.0Q825.0 1.0 815.0 0.5Q805.0 0.0 805.0 0.0H425.0ZM216.0 -200.0Q155.0 -200.0 117.0 -178.0Q79.0 -156.0 59.0 -123.0Q39.0 -90.0 32.0 -56.5Q25.0 -23.0 25.0 0.0Q25.0 44.0 43.5 84.0Q62.0 124.0 91.0 155.5Q120.0 187.0 151.0 207.0Q153.0 188.0 149.0 171.0Q145.0 154.0 131.0 135.0Q142.0 130.0 149.5 117.0Q157.0 104.0 160.0 90.0Q163.0 76.0 160.0 64.0Q145.0 76.0 130.5 77.5Q116.0 79.0 102.0 73.0Q84.0 65.0 73.0 45.5Q62.0 26.0 62.0 -1.0Q62.0 -39.0 79.0 -71.5Q96.0 -104.0 127.5 -123.5Q159.0 -143.0 204.0 -143.0Q247.0 -143.0 272.0 -120.5Q297.0 -98.0 307.5 -56.5Q318.0 -15.0 318.0 40.0V299.0L445.0 327.0V0.0Q445.0 -56.0 419.0 -101.5Q393.0 -147.0 342.5 -173.5Q292.0 -200.0 216.0 -200.0Z" />
        <path d="M924.0 614.0 907.0 644.0 1132.0 774.0 1149.0 744.0Z" />
        <path d="M1028.0 -208.0Q1004.0 -208.0 987.0 -191.0Q970.0 -174.0 970.0 -150.0Q970.0 -126.0 987.0 -109.0Q1004.0 -92.0 1028.0 -92.0Q1052.0 -92.0 1069.0 -109.0Q1086.0 -126.0 1086.0 -150.0Q1086.0 -174.0 1069.0 -191.0Q1052.0 -208.0 1028.0 -208.0Z" />
        <path d="M1045.0 0.0V127.0H1265.0V0.0ZM925.0 0.0V127.0H1018.0V299.0L1145.0 327.0V23.0Q1145.0 11.0 1135.0 6.0Q1125.0 1.0 1115.0 0.5Q1105.0 0.0 1105.0 0.0Z" />
        <path d="M1378.0 814.0 1361.0 844.0 1586.0 974.0 1603.0 944.0Z" />
        <path d="M1568.0 542.0Q1544.0 542.0 1527.0 559.0Q1510.0 576.0 1510.0 600.0Q1510.0 624.0 1527.0 641.0Q1544.0 658.0 1568.0 658.0Q1592.0 658.0 1609.0 641.0Q1626.0 624.0 1626.0 600.0Q1626.0 576.0 1609.0 559.0Q1592.0 542.0 1568.0 542.0ZM1395.0 542.0Q1371.0 542.0 1354.0 559.0Q1337.0 576.0 1337.0 600.0Q1337.0 624.0 1354.0 641.0Q1371.0 658.0 1395.0 658.0Q1419.0 658.0 1436.0 641.0Q1453.0 624.0 1453.0 600.0Q1453.0 576.0 1436.0 559.0Q1419.0 542.0 1395.0 542.0Z" />
        <path d="M1225.0 0.0V127.0H1518.0V255.0L1645.0 327.0V23.0Q1645.0 11.0 1635.0 6.0Q1625.0 1.0 1615.0 0.5Q1605.0 0.0 1605.0 0.0ZM1483.0 163.0Q1438.0 163.0 1401.0 185.0Q1364.0 207.0 1341.5 244.5Q1319.0 282.0 1319.0 327.0Q1319.0 372.0 1341.5 409.0Q1364.0 446.0 1401.0 468.0Q1438.0 490.0 1483.0 490.0Q1528.0 490.0 1564.5 468.0Q1601.0 446.0 1623.0 409.0Q1645.0 372.0 1645.0 327.0Q1645.0 282.0 1623.0 244.5Q1601.0 207.0 1564.5 185.0Q1528.0 163.0 1483.0 163.0ZM1483.0 290.0Q1498.0 290.0 1508.5 300.5Q1519.0 311.0 1519.0 327.0Q1519.0 342.0 1508.5 352.5Q1498.0 363.0 1483.0 363.0Q1467.0 363.0 1456.0 352.5Q1445.0 342.0 1445.0 327.0Q1445.0 311.0 1456.0 300.5Q1467.0 290.0 1483.0 290.0Z" />
      </g>
    </svg>
  )
}

/**
 * Render the Qabas wordmark at the height its host surface asks for.
 * @param props - Host-supplied mark presentation.
 * @returns the قَبَس wordmark.
 */
export function QabasBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <QabasWordmark height={size} />
}

/**
 * Render the Qabas wordmark for the blank-session hero, keeping the host geometry.
 * @param props - Host-supplied hero mark presentation.
 * @returns the قَبَس wordmark inside the host's class.
 */
export function QabasHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <QabasWordmark height={size} className={className} />
}

/**
 * Occupy the brand-name slot with nothing.
 *
 * The mark beside this one is already the whole name, so the slot's generic
 * text fallback -- "DSH Local Build" -- must not appear, and repeating
 * قَبَس next to itself would be worse than either. Registering an empty
 * occupant is how this surface says "the mark carries the brand".
 * @returns nothing.
 */
export function QabasBrandName() {
  return null
}
