"use client";

/** Submit button that asks for confirmation first (destructive admin actions). */
export default function ConfirmSubmit({
  message,
  className = "btn-danger",
  children,
}: {
  message: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
