import LiveFlow from './LiveFlow.jsx';
import RunningChart from './RunningChart.jsx';

export default function LiveBoard({ variant = 'stream', showFlow = false }) {
  return (
    <section className={`live-board ${showFlow ? 'with-flow' : ''}`}>
      {showFlow && <LiveFlow />}
      <RunningChart variant={variant} />
    </section>
  );
}
