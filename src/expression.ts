import { _parse, DaysFieldValues, YearsField, WarningType, Warning } from './parser'
import { CronosDate, CronosTimezone } from './date'
import { DateSequence } from './scheduler'
import { flatMap } from './utils'

const hourinms = 60 * 60 * 1000
const maxYears = 2000
const findFirstFrom = (from: number, list: number[]) => list.findIndex(n => n >= from)

const findLastFrom = (from: number, list: number[]) => {
  const index = list.slice().reverse().findIndex(n => n <= from);
  return index === -1 ? -1 : list.length - 1 - index;
};


export class CronosExpression implements DateSequence {
  private timezone?: CronosTimezone
  private skipRepeatedHour = true
  private missingHour: 'insert' | 'offset' | 'skip' = 'insert'
  private _warnings: Warning[] | null = null

  private constructor(
    public readonly cronString: string,
    private readonly seconds: number[],
    private readonly minutes: number[],
    private readonly hours: number[],
    private readonly days: DaysFieldValues,
    private readonly months: number[],
    private readonly years: YearsField
  ) {}

  static parse(cronstring: string, options: {
    timezone?: string | number | CronosTimezone
    skipRepeatedHour?: boolean
    missingHour?: CronosExpression['missingHour']
    strict?: boolean | {[key in WarningType]?: boolean}
  } = {}) {
    const parsedFields = _parse(cronstring)

    if (options.strict) {
      let warnings = flatMap(parsedFields, field => field.warnings)
      if (typeof options.strict === 'object') {
        warnings = warnings
          .filter(warning => !!(options.strict as {[key in WarningType]?: boolean})[warning.type])
      }
      if (warnings.length > 0) {
        throw new Error(`Strict mode: Parsing failed with ${warnings.length} warnings`)
      }
    }

    const expr = new CronosExpression(
      cronstring,
      parsedFields[0].values,
      parsedFields[1].values,
      parsedFields[2].values,
      parsedFields[3].values,
      parsedFields[4].values,
      parsedFields[5]
    )

    expr.timezone = options.timezone instanceof CronosTimezone ? options.timezone :
      (options.timezone !== undefined ? new CronosTimezone(options.timezone) : undefined)
    expr.skipRepeatedHour = options.skipRepeatedHour !== undefined ? options.skipRepeatedHour : expr.skipRepeatedHour
    expr.missingHour = options.missingHour ?? expr.missingHour

    return expr
  }

  get warnings() {
    if (!this._warnings) {
      const parsedFields = _parse(this.cronString)
      this._warnings = flatMap(parsedFields, field => field.warnings)
    }

    return this._warnings
  }

  toString() {
    const showTzOpts = !this.timezone || !!this.timezone.zoneName
    const timezone = Object.entries({
      tz: this.timezone?.toString() ?? 'Local',
      skipRepeatedHour: showTzOpts && this.skipRepeatedHour.toString(),
      missingHour: showTzOpts && this.missingHour,
    }).map(([key, val]) => val && key+': '+val).filter(s => s).join(', ')
    return `${this.cronString} (${timezone})`
  }

  // next dates
  nextDate(afterDate: Date = new Date()): Date | null {
    const fromCronosDate = CronosDate.fromDate(afterDate, this.timezone)

    if (this.timezone?.fixedOffset !== undefined) {
      return this._next(fromCronosDate).date
    }

    const fromTimestamp = afterDate.getTime(),
          fromLocalTimestamp = fromCronosDate['toUTCTimestamp'](),
          prevHourLocalTimestamp = CronosDate.fromDate( new Date(fromTimestamp - hourinms),
                                     this.timezone )['toUTCTimestamp'](),
          nextHourLocalTimestamp = CronosDate.fromDate( new Date(fromTimestamp + hourinms),
                                     this.timezone )['toUTCTimestamp'](),
          nextHourRepeated = nextHourLocalTimestamp - fromLocalTimestamp === 0,
          thisHourRepeated = fromLocalTimestamp - prevHourLocalTimestamp === 0,
          thisHourMissing = fromLocalTimestamp - prevHourLocalTimestamp === hourinms * 2

    if (this.skipRepeatedHour && thisHourRepeated) {
      return this._next(fromCronosDate.copyWith({ minute: 59, second: 60 }), false).date
    }
    if (this.missingHour === 'offset' && thisHourMissing) {
      const nextDate = this._next(fromCronosDate.copyWith({ hour: fromCronosDate.hour - 1 })).date
      if (!nextDate || nextDate.getTime() > fromTimestamp) return nextDate
    }

    let {date: nextDate, cronosDate: nextCronosDate} = this._next(fromCronosDate)

    if (this.missingHour !== 'offset' && nextCronosDate && nextDate) {
      const nextDateNextHourTimestamp = nextCronosDate.copyWith({hour: nextCronosDate.hour + 1}).toDate(this.timezone).getTime() 
      if (nextDateNextHourTimestamp === nextDate.getTime()) {
        if (this.missingHour === 'insert') {
          return nextCronosDate.copyWith({minute: 0, second: 0}).toDate(this.timezone)
        }
        // this.missingHour === 'skip'
        return this._next( nextCronosDate.copyWith({minute: 59, second: 59}) ).date
      }
    }

    if (!this.skipRepeatedHour) {
      if ( nextHourRepeated && (!nextDate || (nextDate.getTime() > fromTimestamp + hourinms)) ) {
        nextDate = this._next(fromCronosDate.copyWith({ minute: 0, second: 0 }), false).date
      }
      if ( nextDate && nextDate < afterDate ) {
        nextDate = new Date(nextDate.getTime() + hourinms)
      }
    }

    return nextDate
  }

  private _next(date: CronosDate, after = true) {
    const nextDate = this._nextYear(
      after ? date.copyWith({second: date.second + 1}) : date
    )

    return {
      cronosDate: nextDate,
      date: nextDate ? nextDate.toDate(this.timezone) : null
    }
  }

  nextNDates(afterDate: Date = new Date(), n: number = 5) {
    const dates = []

    let lastDate = afterDate
    for (let i = 0; i < n; i++) {
      const date = this.nextDate(lastDate)
      if (!date) break;
      lastDate = date
      dates.push(date)
    }

    return dates
  }

  private _nextYear(fromDate: CronosDate): CronosDate | null {
    let year: number | null = fromDate.year

    let nextDate = null

    while (!nextDate) {
      year = this.years.nextYear(year)
      if (year === null || year >= fromDate.year + maxYears) return null

      nextDate = this._nextMonth(
        (year === fromDate.year) ? fromDate : new CronosDate(year)
      )

      year++
    }

    return nextDate
  }

  private _nextMonth(fromDate: CronosDate): CronosDate | null {
    let nextMonthIndex = findFirstFrom(fromDate.month, this.months)

    let nextDate = null

    while (!nextDate) {
      const nextMonth = this.months[nextMonthIndex]
      if (nextMonth === undefined) return null

      nextDate = this._nextDay(
        (nextMonth === fromDate.month) ? fromDate : new CronosDate(fromDate.year, nextMonth)
      )

      nextMonthIndex++
    }

    return nextDate
  }

  private _nextDay(fromDate: CronosDate): CronosDate | null {
    const days = this.days.getDays(fromDate.year, fromDate.month)

    let nextDayIndex = findFirstFrom(fromDate.day, days)

    let nextDate = null

    while (!nextDate) {
      const nextDay = days[nextDayIndex]
      if (nextDay === undefined) return null

      nextDate = this._nextHour(
        (nextDay === fromDate.day) ? fromDate : new CronosDate(fromDate.year, fromDate.month, nextDay)
      )

      nextDayIndex++
    }

    return nextDate
  }

  

  private _nextHour(fromDate: CronosDate): CronosDate | null {
    let nextHourIndex = findFirstFrom(fromDate.hour, this.hours)

    let nextDate = null

    while (!nextDate) {
      const nextHour = this.hours[nextHourIndex]
      if (nextHour === undefined) return null

      nextDate = this._nextMinute(
        (nextHour === fromDate.hour) ? fromDate :
          new CronosDate(fromDate.year, fromDate.month, fromDate.day, nextHour)
      )

      nextHourIndex++
    }

    return nextDate
  }

  private _nextMinute(fromDate: CronosDate): CronosDate | null {
    let nextMinuteIndex = findFirstFrom(fromDate.minute, this.minutes)

    let nextDate = null

    while (!nextDate) {
      const nextMinute = this.minutes[nextMinuteIndex]
      if (nextMinute === undefined) return null

      nextDate = this._nextSecond(
        (nextMinute === fromDate.minute) ? fromDate :
          new CronosDate(fromDate.year, fromDate.month, fromDate.day, fromDate.hour, nextMinute)
      )

      nextMinuteIndex++
    }

    return nextDate
  }

  private _nextSecond(fromDate: CronosDate): CronosDate | null {
    const nextSecondIndex = findFirstFrom(fromDate.second, this.seconds),
          nextSecond = this.seconds[nextSecondIndex]

    if (nextSecond === undefined) return null

    return fromDate.copyWith({second: nextSecond})
  }

  // previous dates
  previousDate(beforeDate: Date = new Date()): Date | null {
    const fromCronosDate = CronosDate.fromDate(beforeDate, this.timezone)

    if (this.timezone?.fixedOffset !== undefined) {
      return this._previous(fromCronosDate).date
    }

    const fromTimestamp = beforeDate.getTime(),
          fromLocalTimestamp = fromCronosDate['toUTCTimestamp'](),
          prevHourLocalTimestamp = CronosDate.fromDate(new Date(fromTimestamp - hourinms), this.timezone)['toUTCTimestamp'](),
          nextHourLocalTimestamp = CronosDate.fromDate(new Date(fromTimestamp + hourinms), this.timezone)['toUTCTimestamp'](),
          prevHourRepeated = prevHourLocalTimestamp - fromLocalTimestamp === 0,
          thisHourRepeated = fromLocalTimestamp - nextHourLocalTimestamp === 0,
          thisHourMissing = fromLocalTimestamp - nextHourLocalTimestamp === hourinms * 2

    if (this.skipRepeatedHour && prevHourRepeated) {
      return this._previous(fromCronosDate.copyWith({ minute: 0, second: -1 }), false).date
    }
    if (this.missingHour === 'offset' && thisHourMissing) {
      const previousDate = this._previous(fromCronosDate.copyWith({ hour: fromCronosDate.hour + 1 })).date
      if (!previousDate || previousDate.getTime() < fromTimestamp) return previousDate
    }

    let { date: previousDate, cronosDate: previousCronosDate } = this._previous(fromCronosDate)

    if (this.missingHour !== 'offset' && previousCronosDate && previousDate) {
      const previousDatePrevHourTimestamp = previousCronosDate.copyWith({ hour: previousCronosDate.hour - 1 }).toDate(this.timezone).getTime()
      if (previousDatePrevHourTimestamp === previousDate.getTime()) {
        if (this.missingHour === 'insert') {
          return previousCronosDate.copyWith({ minute: 59, second: 59 }).toDate(this.timezone)
        }
        // this.missingHour === 'skip'
        return this._previous(previousCronosDate.copyWith({ minute: 0, second: 0 })).date
      }
    }

    if (!this.skipRepeatedHour) {
      if (prevHourRepeated && (!previousDate || (previousDate.getTime() < fromTimestamp - hourinms))) {
        previousDate = this._previous(fromCronosDate.copyWith({ minute: 59, second: 59 }), false).date
      }
      if (previousDate && previousDate > beforeDate) {
        previousDate = new Date(previousDate.getTime() - hourinms)
      }
    }

    return previousDate
  }

  private _previous(date: CronosDate, after = true) {
    const previousDate = this._previousYear(
      after ? date.copyWith({ second: date.second - 1 }) : date
    )

    return {
      cronosDate: previousDate,
      date: previousDate ? previousDate.toDate(this.timezone) : null
    }
  }

  previousNDates(beforeDate: Date = new Date(), n: number = 5) {
    const dates = []
  
    let lastDate = beforeDate
    for (let i = 0; i < n; i++) {
      const date = this.previousDate(lastDate)
      if (!date) break;
      lastDate = date
      dates.push(date)
    }
  
    return dates
  }  

  private _previousYear(fromDate: CronosDate): CronosDate | null {
    let year: number | null = fromDate.year

    let previousDate = null

    while (!previousDate) {
      year = this.years.previousYear(year)
      if (year === null || year <= fromDate.year - maxYears) return null

      previousDate = this._previousMonth(
        (year === fromDate.year) ? fromDate : new CronosDate(year)
      )

      year--
    }

    return previousDate
  }

  private _previousMonth(fromDate: CronosDate): CronosDate | null {
    let previousMonthIndex = findLastFrom(fromDate.month, this.months)

    let previousDate = null

    while (!previousDate) {
      const previousMonth = this.months[previousMonthIndex]
      if (previousMonth === undefined) return null

      previousDate = this._previousDay(
        (previousMonth === fromDate.month) ? fromDate : new CronosDate(fromDate.year, previousMonth)
      )

      previousMonthIndex--
    }

    return previousDate
  }

  private _previousDay(fromDate: CronosDate): CronosDate | null {
    const days = this.days.getDays(fromDate.year, fromDate.month)

    let previousDayIndex = findLastFrom(fromDate.day, days)

    let previousDate = null

    while (!previousDate) {
      const previousDay = days[previousDayIndex]
      if (previousDay === undefined) return null

      previousDate = this._previousHour(
        (previousDay === fromDate.day) ? fromDate : new CronosDate(fromDate.year, fromDate.month, previousDay)
      )

      previousDayIndex--
    }

    return previousDate
  }

  private _previousHour(fromDate: CronosDate): CronosDate | null {
    let previousHourIndex = findLastFrom(fromDate.hour, this.hours)

    let previousDate = null

    while (!previousDate) {
      const previousHour = this.hours[previousHourIndex]
      if (previousHour === undefined) return null

      previousDate = this._previousMinute(
        (previousHour === fromDate.hour) ? fromDate :
          new CronosDate(fromDate.year, fromDate.month, fromDate.day, previousHour)
      )

      previousHourIndex--
    }

    return previousDate
  }

  private _previousMinute(fromDate: CronosDate): CronosDate | null {
    let previousMinuteIndex = findLastFrom(fromDate.minute, this.minutes)

    let previousDate = null

    while (!previousDate) {
      const previousMinute = this.minutes[previousMinuteIndex]
      if (previousMinute === undefined) return null

      previousDate = this._previousSecond(
        (previousMinute === fromDate.minute) ? fromDate :
          new CronosDate(fromDate.year, fromDate.month, fromDate.day, fromDate.hour, previousMinute)
      )

      previousMinuteIndex--
    }

    return previousDate
  }

  private _previousSecond(fromDate: CronosDate): CronosDate | null {
    const previousSecondIndex = findLastFrom(fromDate.second, this.seconds),
          previousSecond = this.seconds[previousSecondIndex]

    if (previousSecond === undefined) return null

    return fromDate.copyWith({ second: previousSecond })
  }
}
