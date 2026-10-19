import { regulationLabel, regulationPath } from "@/lib/tennis/regulations";

/** "ITF Reg. 43": opens Move Score's own summary of the regulation (with the button to the ITF's document). */
export function RegLink({ reg, className = "" }: { reg: string; className?: string }) {
  return (
    <a href={regulationPath(reg)} target="_blank" rel="noreferrer" className={`font-semibold underline underline-offset-2 ${className}`} data-testid="reg-link" data-reg={reg}>
      {regulationLabel(reg)}
    </a>
  );
}

/** One problem or warning: its words, then the regulation link. */
export function IssueText({ issue }: { issue: { message: string; reg: string | null } }) {
  return (
    <>
      {issue.message}
      {issue.reg ? (
        <>
          {" "}
          <RegLink reg={issue.reg} />.
        </>
      ) : null}
    </>
  );
}
