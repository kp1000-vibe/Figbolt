import { ToastProvider } from '@/components/ui/feedback';

/**
 * Setup shell.
 *
 * Deliberately outside the `(app)` group: that layout redirects to
 * `/onboarding` whenever onboarding is unfinished, so rendering onboarding
 * inside it would loop forever. This group has no gate — only toasts.
 */
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="min-h-dvh bg-bg-subtle">{children}</div>
    </ToastProvider>
  );
}
