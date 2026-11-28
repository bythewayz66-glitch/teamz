import type { SessionIntro } from '../types';

/** Shown in the first session of an agent made from a library template. Nothing is sent until the user runs it. */
export function FirstJobCard({ intro, onRun }: { intro: SessionIntro; onRun: (prompt: string) => void }) {
  const job = intro.job;
  return (
    <section className="firstjob" aria-label="First job">
      <h3>{job ? 'Its first job' : 'No first job on record'}</h3>
      {job ? (
        <>
          <p className="firstjob-title">{job.title}</p>
          <p className="firstjob-meta">
            {job.kind === 'recurring' && job.schedule
              ? `Recurring (cron ${job.schedule}) on the runner. Running it here is one pass, now.`
              : 'A one-off job.'}{' '}
            From {intro.jobSource ?? 'the template'}, template {intro.template}.
          </p>
          <pre className="firstjob-prompt">{job.prompt}</pre>
          <div className="firstjob-actions">
            <button className="btn primary sm" onClick={() => onRun(job.prompt)}>
              Run this job
            </button>
            <span className="firstjob-hint">Or type something else below. This sends one request to the agent.</span>
          </div>
        </>
      ) : (
        <p className="firstjob-meta">
          Template {intro.template} carries no first job, and none is invented. Tell the agent what you want first.
        </p>
      )}
    </section>
  );
}
