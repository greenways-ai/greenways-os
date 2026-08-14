import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../controller/setup_controller.dart';
import '../model/setup_snapshot.dart';
import 'presentation.dart';

part 'setup_view_components.dart';

final class SetupView extends StatelessWidget {
  const SetupView({
    super.key,
    required this.snapshot,
    required this.controller,
    required this.onOpenOverview,
  });

  final DesktopSetupSnapshot snapshot;
  final SetupController controller;
  final VoidCallback onOpenOverview;

  @override
  Widget build(BuildContext context) {
    return KeyedSubtree(
      key: const Key('setup-view'),
      child: _SetupPageFrame(
        eyebrow: 'LOCAL INSTALLATION',
        title: 'Set up this Greenways installation',
        subtitle: 'Inspect and establish the fixed local daemon service without exposing credentials, sessions, private keys, or caller-supplied paths.',
        children: [
          _SetupSummary(
            snapshot: snapshot,
            controller: controller,
            onOpenOverview: onOpenOverview,
          ),
          const SizedBox(height: 18),
          if (snapshot.components.isEmpty)
            _SetupInspectionBoundary(snapshot: snapshot)
          else
            _SetupComponentList(snapshot: snapshot),
          const SizedBox(height: 18),
          _SetupDiagnostics(snapshot: snapshot, controller: controller),
        ],
      ),
    );
  }
}

final class _SetupSummary extends StatelessWidget {
  const _SetupSummary({
    required this.snapshot,
    required this.controller,
    required this.onOpenOverview,
  });

  final DesktopSetupSnapshot snapshot;
  final SetupController controller;
  final VoidCallback onOpenOverview;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final ready = snapshot.mandatoryReady;
    final information = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 54,
          height: 54,
          decoration: BoxDecoration(
            color: ready
                ? const Color(0xFFDDEDE5)
                : scheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(17),
          ),
          child: snapshot.state == DesktopSetupState.inspecting
              ? const Padding(
                  padding: EdgeInsets.all(16),
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Icon(
                  snapshot.state.icon,
                  color: ready ? const Color(0xFF176246) : null,
                ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                snapshot.state.title,
                style: Theme.of(context).textTheme.headlineSmall
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 7),
              Text(
                _setupStateDescription(snapshot),
                style: Theme.of(context).textTheme.bodyLarge
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
              if (snapshot.error != null) ...[
                const SizedBox(height: 10),
                Text(
                  snapshot.error!.message,
                  style: Theme.of(context).textTheme.bodyMedium
                      ?.copyWith(fontWeight: FontWeight.w600),
                ),
              ],
            ],
          ),
        ),
      ],
    );
    final actions = ready
        ? Wrap(
            key: const Key('setup-primary-action'),
            spacing: 10,
            runSpacing: 10,
            alignment: WrapAlignment.end,
            children: [
              OutlinedButton.icon(
                onPressed: controller.busy ? null : controller.inspect,
                icon: const Icon(Icons.refresh),
                label: const Text('Check again'),
              ),
              FilledButton.icon(
                onPressed: onOpenOverview,
                icon: const Icon(Icons.arrow_forward),
                label: const Text('Open Overview'),
              ),
            ],
          )
        : _SetupPrimaryAction(snapshot: snapshot, controller: controller);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: LayoutBuilder(
          builder: (context, constraints) {
            if (constraints.maxWidth < 700) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [information, const SizedBox(height: 20), actions],
              );
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(child: information),
                const SizedBox(width: 24),
                actions,
              ],
            );
          },
        ),
      ),
    );
  }
}

final class _SetupPrimaryAction extends StatelessWidget {
  const _SetupPrimaryAction({required this.snapshot, required this.controller});

  final DesktopSetupSnapshot snapshot;
  final SetupController controller;

  @override
  Widget build(BuildContext context) {
    final operation = snapshot.permittedActions.isEmpty
        ? null
        : snapshot.permittedActions.first;
    final (label, icon, action) = switch (operation) {
      DesktopSetupOperation.installDaemon => (
        snapshot.state == DesktopSetupState.restartRequired
            ? 'Restart daemon service'
            : 'Install daemon service',
        Icons.download_outlined,
        controller.installDaemon,
      ),
      DesktopSetupOperation.repairPermissions => (
        'Repair private permissions',
        Icons.build_outlined,
        controller.repairPermissions,
      ),
      DesktopSetupOperation.issueDesktopClient => (
        'Establish Desktop access',
        Icons.key_outlined,
        controller.issueDesktopClient,
      ),
      _ => (
        snapshot.inspected ? 'Check again' : 'Check local components',
        Icons.search,
        controller.inspect,
      ),
    };
    return FilledButton.icon(
      key: const Key('setup-primary-action'),
      onPressed: controller.busy ? null : action,
      icon: controller.busy
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(icon),
      label: Text(label),
    );
  }
}

final class _SetupInspectionBoundary extends StatelessWidget {
  const _SetupInspectionBoundary({required this.snapshot});

  final DesktopSetupSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.visibility_outlined),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    snapshot.state == DesktopSetupState.inspecting
                        ? 'Reading bounded component state'
                        : 'Closed local administration',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 7),
                  const Text(
                    'This slice may install or restart only the packaged greenwaysd binary and its exact LaunchAgent, or repair fixed private modes. Credential enrollment, identity creation, and browser installation remain unavailable.',
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
