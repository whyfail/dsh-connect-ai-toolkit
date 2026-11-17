import { describe, expect, it } from 'vitest'
import { displayedCreditRate, formatCreditRate, formatMultiplier } from '../src/rate.ts'
import type { CreditRate } from '../src/shared.ts'

// 2026-01-01T02:30:00Z == 10:30 in UTC+8.
const TS = Date.UTC(2026, 0, 1, 2, 30)
const clock = { now: () => TS, localOffsetMinutes: () => -480 }
const at = (hour: number, minute = 0) => ({ now: () => Date.UTC(2026, 0, 1, hour, minute) - 8 * 3_600_000, localOffsetMinutes: () => -480 })

describe('credit rate display', () => {
  it('formats declared multipliers and keeps unknown rates explicit', () => {
    expect(formatCreditRate({ multiplier: 0.78 }, clock)).toBe('0.78×')
    expect(formatCreditRate({ multiplier: 1 }, clock)).toBe('1×')
    expect(formatCreditRate({ multiplier: 0 }, clock)).toBe('0×')
    expect(formatCreditRate({ multiplier: null }, clock)).toBe('倍率未知')
    expect(formatCreditRate(undefined, clock)).toBe('倍率未知')
    expect(formatMultiplier(0.5 * 0.1)).toBe('0.05×')
  })

  it('recovers the WorkBuddy prefix text only for its enterprise catalog', () => {
    expect(formatCreditRate({ declaredText: '0.6x', source: 'enterprise-models/v3-config' }, clock)).toBe('0.6×')
    expect(formatCreditRate({ declaredText: '0.6x', source: 'other' }, clock)).toBe('倍率未知')
  })

  it('prefers an active promotion over the base rate', () => {
    const rate: CreditRate = {
      multiplier: 1,
      promotions: [{ id: 'day', discountedCredits: 0.5, priority: 1, dailyStartMinute: 600, dailyEndMinute: 720, timezoneOffsetSeconds: 28_800 }],
    }
    expect(displayedCreditRate(rate, at(0, 10)).multiplier).toBe(1)
    expect(formatCreditRate(rate, at(10, 0))).toBe('0.5× · 优惠')
    expect(formatCreditRate(rate, at(12, 0))).toBe('1×')
    expect(displayedCreditRate(rate, at(11, 30))).toMatchObject({ promotional: true, base: 1 })
  })

  it('supports overnight windows, timezones and exclusive end times', () => {
    const overnight: CreditRate = {
      multiplier: 2,
      promotions: [{ id: 'night', discountedCredits: 1, dailyStartMinute: 1320, dailyEndMinute: 360, timezoneOffsetSeconds: 28_800 }],
    }
    expect(formatCreditRate(overnight, at(23, 0))).toBe('1× · 优惠')
    expect(formatCreditRate(overnight, at(5, 59))).toBe('1× · 优惠')
    expect(formatCreditRate(overnight, at(6, 0))).toBe('2×')
    const ends: CreditRate = { multiplier: 1, promotions: [{ id: 'flash', discountedCredits: 0.2, endsAt: TS }] }
    expect(formatCreditRate(ends, clock)).toBe('1×')
    expect(formatCreditRate(ends, at(10, 29))).toBe('0.2× · 优惠')
    const disabled: CreditRate = { multiplier: 1, promotions: [{ id: 'off', discountedCredits: 0.2, enabled: false }] }
    expect(formatCreditRate(disabled, clock)).toBe('1×')
  })

  it('applies the discount factor to the base rate and lets the highest priority win', () => {
    const factor: CreditRate = {
      multiplier: 0.8,
      promotions: [
        { id: 'low', discountFactor: 0.5, priority: 1 },
        { id: 'high', discountedCredits: 0.3, priority: 2 },
      ],
    }
    expect(formatCreditRate(factor, clock)).toBe('0.3× · 优惠')
    // A higher-priority promotion that is not a discount cannot resolve a rate; the base stays.
    expect(formatCreditRate({ multiplier: 0.8, promotions: [{ id: 'bonus', kind: 'bonus', discountedCredits: 0.01, priority: 9 }] }, clock)).toBe('0.8×')
    expect(formatCreditRate({ multiplier: 0.8, promotions: [{ id: 'p', discountFactor: 0.5 }] }, clock)).toBe('0.4× · 优惠')
    // A promotion that cannot resolve a value falls back to the base rate.
    expect(formatCreditRate({ multiplier: 0.8, promotions: [{ id: 'p', discountFactor: 1 }] }, clock)).toBe('0.8×')
  })
})