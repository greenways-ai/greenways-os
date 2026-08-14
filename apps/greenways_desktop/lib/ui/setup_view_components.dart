part of 'setup_view.dart';

final class _SetupComponentList extends StatelessWidget {
  const _SetupComponentList({required this.snapshot});

  final DesktopSetupSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Local components',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 16),
            for (var index = 0; index < snapshot.components.length; index++)
              _SetupComponentRow(
                component: snapshot.components[index],
                last: index == snapshot.components.length - 1,
              ),
          ],
        ),
      ),
    );
  }
}

final class _SetupComponentRow extends StatelessWidget {
  const _SetupComponentRow({required this.component, required this.last});

  final DesktopSetupComponent component;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final ready = component.state == DesktopSetupState.ready;
    final scheme = Theme.of(context).colorScheme;
    return Container(
      key: Key('setup-component-${component.kind.wireName}'),
      padding: EdgeInsets.only(bottom: last ? 0 : 16),
      margin: EdgeInsets.only(bottom: last ? 0 : 16),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: ready
                  ? const Color(0xFFDDEDE5)
                  : scheme.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(13),
            ),
            child: Icon(
              component.kind.icon,
              size: 21,
              color: ready ? const Color(0xFF176246) : scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  component.kind.title,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 3),
                Text(
                  component.kind.description,
                  style: Theme.of(context).textTheme.bodySmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
                if (component.version != null ||
                    component.publicId != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    [
                      component.version,
                      component.publicId,
                    ].whereType<String>().join(' · '),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 150),
            child: Text(
              component.state.title,
              textAlign: TextAlign.end,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: ready
                    ? const Color(0xFF176246)
                    : scheme.onSurfaceVariant,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

final class _SetupDiagnostics extends StatelessWidget {
  const _SetupDiagnostics({required this.snapshot, required this.controller});

  final DesktopSetupSnapshot snapshot;
  final SetupController controller;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final copy = OutlinedButton.icon(
              onPressed: snapshot.state == DesktopSetupState.inspecting
                  ? null
                  : () async {
                      await Clipboard.setData(
                        ClipboardData(text: controller.diagnosticsJson()),
                      );
                      if (!context.mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('Redacted setup diagnostics copied.'),
                        ),
                      );
                    },
              icon: const Icon(Icons.copy),
              label: const Text('Copy'),
            );
            final information = Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.shield_outlined),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Redacted setup diagnostics',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Includes component kinds, public versions or IDs, bounded state, and error codes only. Private paths and private authentication, session, key, or recovery material are rejected.',
                      ),
                    ],
                  ),
                ),
              ],
            );
            if (constraints.maxWidth < 620) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [information, const SizedBox(height: 16), copy],
              );
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: information),
                const SizedBox(width: 16),
                copy,
              ],
            );
          },
        ),
      ),
    );
  }
}

String _setupStateDescription(
  DesktopSetupSnapshot snapshot,
) => switch (snapshot.state) {
  DesktopSetupState.notInspected => 'Check the fixed Greenways home, daemon, Desktop access, identity, and browser companion boundaries.',
  DesktopSetupState.inspecting =>
    'Reading public component state without changing the installation.',
  DesktopSetupState.ready =>
    'The required local boundary is ready for Desktop connection.',
  DesktopSetupState.installRequired =>
    'One or more required local components are not installed yet.',
  DesktopSetupState.upgradeRequired =>
    'A local component does not match this Desktop build.',
  DesktopSetupState.permissionRepairRequired =>
    'Private installation permissions need an explicit repair.',
  DesktopSetupState.credentialRequired =>
    'A private Desktop-role credential has not been enrolled.',
  DesktopSetupState.credentialRoleMismatch =>
    'The fixed Desktop credential exists but carries another role.',
  DesktopSetupState.identityOptional => 'The daemon and Desktop access are ready; create a public identity now or continue without one.',
  DesktopSetupState.browserCompanionOptional =>
    'The core Desktop boundary is ready; browser connection remains optional.',
  DesktopSetupState.verifying =>
    'Verifying a real connection-bound local session.',
  DesktopSetupState.complete => 'All selected local components are verified.',
  DesktopSetupState.restartRequired =>
    'The local daemon state exists but the service is not reachable.',
  DesktopSetupState.manualRecoveryRequired =>
    'The existing installation does not match the closed setup contract.',
  DesktopSetupState.failed =>
    'The bounded setup inspection could not be completed.',
};

final class _SetupPageFrame extends StatelessWidget {
  const _SetupPageFrame({
    required this.eyebrow,
    required this.title,
    required this.subtitle,
    required this.children,
  });

  final String eyebrow;
  final String title;
  final String subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 28, 24, 36),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1120),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                eyebrow,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: Theme.of(context).colorScheme.secondary,
                  letterSpacing: 1.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                title,
                style: Theme.of(context).textTheme.displaySmall
                    ?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -1),
              ),
              const SizedBox(height: 7),
              Text(
                subtitle,
                style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 24),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}
