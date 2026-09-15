import { NextRequest, NextResponse } from 'next/server';
import { corporateActions, normalizeCashDividends, resolveMultiplierPair } from '@/lib/xstocks';
import { dividendRawAtomic, sourceExposurePreserved, scaledExposure } from '@/lib/math';

/**
 * Replay Mode — a real historical corporate action, never presented as live.
 *
 * Uses the same strict event→multiplier resolution as the live engine. If the
 * event cannot be matched, it says so rather than substituting a nearby pair.
 * The balance is an explicit fixture, and the response labels it as such: this
 * demonstrates the maths, it does not claim a historical swap took place.
 */
export async function POST(req: NextRequest) {
  try {
    const { symbol = 'MRKx', rawBalanceAtomic = '100000000', decimals = 8, eventId } = await req.json();

    const events = normalizeCashDividends(await corporateActions(), symbol)
      .sort((a, b) => Date.parse(b.effectiveAt || '0') - Date.parse(a.effectiveAt || '0'));
    const event = eventId ? events.find(e => e.eventId === eventId) : events[0];
    if (!event) return NextResponse.json({ error: `No historical cash dividend found for ${symbol}` }, { status: 404 });

    const pair = await resolveMultiplierPair(symbol, event.eventId);
    if (!pair) {
      return NextResponse.json({
        error: 'Could not match this corporate action to a multiplier change in the published history',
        event
      }, { status: 409 });
    }

    const before = BigInt(rawBalanceAtomic);
    const raw = dividendRawAtomic(before, pair.m0, pair.m1);

    return NextResponse.json({
      mode: 'REPLAY',
      label: 'REPLAY MODE — HISTORICAL CORPORATE ACTION, NOT A LIVE EXECUTION',
      disclosure: 'Balance is a stated fixture. No swap occurred and no wallet held this position at the time of the event.',
      event,
      m0: pair.m0,
      m1: pair.m1,
      formula: 'removed = floor(raw * (m1 - m0) / m1)',
      rawBalanceFixture: before.toString(),
      rawDividendAtomic: raw.toString(),
      exposureBefore: scaledExposure(before, decimals, pair.m0).toFixed(8),
      exposureAfter: scaledExposure(before - raw, decimals, pair.m1).toFixed(8),
      preserved: sourceExposurePreserved({
        rawBefore: before, rawRemoved: raw, decimals,
        multiplierBefore: pair.m0, multiplierAfter: pair.m1
      })
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
