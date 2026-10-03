/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

const FLAME = 'M42 50a9 9 0 0 1-9-9c0-9.5 7-16 12.5-25.5 1.5 4.5 1 8-1 11.5 4.3 2.5 6.5 7.8 6.5 13a9 9 0 0 1-9 10z'
const SYMBOL = '<svg viewBox="0 0 64 64" width="44" height="44" aria-hidden="true">'
  + '<rect width="64" height="64" rx="15" fill="var(--dsw-alias-brand-primary, #A9521A)"/>'
  + `<g fill="var(--dsw-alias-bg-base, #FBF8F4)"><path d="${FLAME}" transform="translate(-20 0)" opacity="0.55"/><path d="${FLAME}"/></g></svg>`

/** The wordmark (ui-brand-qabas QabasWordmark): Aref Ruqaa as outlines, so it needs no font while the app loads. */
const WORDMARK = '<svg viewBox="0 0 1264 1320" height="40" role="img" aria-label="قَبَس" fill="currentColor" style="width:auto">'
  + '<g transform="translate(27, 1300) scale(1, -1)">'
  + '<path d="M638 544Q630 544 628 539Q626 534 624 527Q617 501 602.5 485Q588 469 562 461Q563 468 563 474.5Q563 481 563 488V4'
  + '97Q563 513 551 513Q543 513 537 502Q532 494 528 482Q524 470 516 464Q460 429 440 429Q437 429 436 430Q427 447 418'
  + ' 465Q409 483 400 503Q396 511 389 510.5Q382 510 379 502L326 371Q335 342 342.5 312.5Q350 283 350 245V242Q339 232'
  + ' 327 223Q315 214 301 206Q272 189 233.5 175.5Q195 162 150 162Q137 162 123.5 163Q110 164 94 167Q71 177 62 190.5Q'
  + '53 204 53 230Q53 238 54 247.5Q55 257 57 265Q63 293 75.5 317.5Q88 342 99 364Q104 375 110 385.5Q116 396 116 410Q'
  + '116 428 99 428Q89 428 80 413Q59 375 43 339.5Q27 304 16 272Q-7 206 -7 161Q-7 159 -7 157.5Q-7 156 -7 153Q-7 151 '
  + '-6.5 149.5Q-6 148 -6 146Q-1 101 16.5 66Q34 31 66 15V16Q82 9 98.5 4.5Q115 0 132 0Q151 0 171 4.5Q191 9 213 16Q29'
  + '9 48 353 127Q369 149 379.5 169Q390 189 397 206L426 282Q439 287 451.5 292Q464 297 477 304L480 305Q485 302 493 3'
  + '02Q495 302 501 304Q530 311 557 323Q584 335 600 354Q624 386 635.5 431Q647 476 652 527V531Q650 544 638 544Z'
  + '"/>'
  + '<path d="M717 862 684 809Q680 802 685 796Q690 790 697 794Q720 805 744.5 815.5Q769 826 795 835L904 874L934 923Q939 931 9'
  + '34 935.5Q929 940 922 938Q873 921 818.5 901.5Q764 882 717 862Z'
  + '"/>'
  + '<path d="M843 195 777 258Q773 262 767.5 261Q762 260 759 256Q740 231 720.5 207Q701 183 681 158Q675 150 682 143L749 80Q75'
  + '3 76 758 76.5Q763 77 766 81Q776 93 780.5 99.5Q785 106 790 112Q795 118 805 130Q815 142 825 154Q835 166 845 179Q'
  + '850 188 843 195Z'
  + '"/>'
  + '<path d="M769 619 778 513Q747 500 709.5 492Q672 484 635 477Q628 475 626 470L563 338Q559 331 564.5 324.5Q570 318 577 321'
  + 'L729 370Q745 379 758.5 388Q772 397 785 409L791 332Q792 323 800 321.5Q808 320 812 327L886 443L865 731Q864 740 8'
  + '56 741.5Q848 743 843 736Z'
  + '"/>'
  + '<path d="M998 1203 965 1150Q961 1143 966 1137Q971 1131 978 1135Q1001 1146 1025.5 1156.5Q1050 1167 1076 1176L1185 1215L1'
  + '215 1264Q1220 1272 1215 1276.5Q1210 1281 1203 1279Q1154 1262 1099.5 1242.5Q1045 1223 998 1203Z'
  + '"/>'
  + '<path d="M1139 934 1196 1047Q1201 1055 1196 1060.5Q1191 1066 1184 1064Q1139 1055 1093.5 1046.5Q1048 1038 1001 1030Q999 '
  + '1029 996 1027.5Q993 1026 992 1024L936 910Q932 903 936.5 897.5Q941 892 948 893Q994 901 1039.5 910Q1085 919 1131'
  + ' 927Q1137 930 1139 934Z'
  + '"/>'
  + '<path d="M1012 567Q1031 567 1047 574.5Q1063 582 1073 590Q1073 588 1075 583.5Q1077 579 1079 572L1087 546Q1074 538 1051.5'
  + ' 529Q1029 520 997 510Q965 500 923.5 489.5Q882 479 830 468Q821 466 821 459L799 335Q798 328 802 324Q806 320 813 '
  + '321Q960 353 1008 378Q1032 391 1055 409Q1078 427 1099 451V450Q1122 475 1137 508.5Q1152 542 1162 581Q1166 595 11'
  + '68.5 610.5Q1171 626 1171 642Q1171 689 1150 727Q1129 765 1100 786Q1094 790 1087.5 793.5Q1081 797 1072 797Q1050 '
  + '797 1031 772Q1011 744 996.5 713.5Q982 683 965 652Q956 637 956 615Q956 590 972 578.5Q988 567 1012 567Z'
  + '"/>'
  + '</g></svg>'

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly wordmark: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.wordmark = div(css.wordmark)
    // The brand symbol (ui-brand-qabas QabasSymbol): two quotation marks that
    // are also two flames. Static markup, so the page needs no React for it.
    this.wordmark.innerHTML = SYMBOL + WORDMARK
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, 'بيجهّز الإضافات…')
    this.card.append(this.wordmark, this.spinner, this.hint)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'مش قادر يحمّل الإضافات'))
    for (const id of failed) {
      const item = div(css.failedItem, id)
      item.dir = 'ltr'
      report.append(item)
    }
    if (this.failure !== undefined) {
      const item = div(css.failedItem, this.failure)
      item.dir = 'ltr'
      report.append(item)
    }
    this.card.replaceChildren(this.wordmark, report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
