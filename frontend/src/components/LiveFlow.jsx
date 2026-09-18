import { Mark } from './icons.jsx';

/**
 * Three stations in a line. The keep rail is dashed. The send rail runs.
 */
export default function LiveFlow() {
  return (
    <div className="pipe" role="img" aria-label="Source stays locked. Earnings run through the Capital Firewall to the destination.">
      <FlowNode kind="lock" label="Source" sub="stays locked" />
      <div className="pipe-rail keep" aria-hidden="true"><span /></div>
      <FlowNode kind="shield" label="Firewall" sub="price gate" />
      <div className="pipe-rail send" aria-hidden="true"><span /><i /><i /><i /><i /></div>
      <FlowNode kind="dest" label="Destination" sub="earnings only" />
    </div>
  );
}

function FlowNode({ kind, label, sub }) {
  return (
    <div className="flow-node">
      <Mark kind={kind} size={56} />
      <b>{label}</b>
      <span>{sub}</span>
    </div>
  );
}
