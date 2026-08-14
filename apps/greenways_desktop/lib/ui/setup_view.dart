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
          if (snapshot.component(DesktopSetupComponentKind.identity)?.state ==
              DesktopSetupState.identityOptional) ...[
            const SizedBox(height: 18),
            _IdentitySetupCard(
              controller: controller,
              onContinue: onOpenOverview,
            ),
          ],
          if (snapshot.state == DesktopSetupState.browserCompanionOptional &&
              snapshot
                      .component(DesktopSetupComponentKind.browserCompanion)
                      ?.state ==
                  DesktopSetupState.browserCompanionOptional) ...[
            const SizedBox(height: 18),
            _BrowserCompanionSetupCard(
              controller: controller,
              onContinue: onOpenOverview,
            ),
          ],
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
      DesktopSetupOperation.recoverIdentity => (
        'Recover existing identity',
        Icons.restore_outlined,
        controller.recoverIdentity,
      ),
      DesktopSetupOperation.installBrowserBridge => (
        'Install Chrome companion',
        Icons.extension_outlined,
        controller.installBrowserBridge,
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

final class _IdentitySetupCard extends StatefulWidget {
  const _IdentitySetupCard({
    required this.controller,
    required this.onContinue,
  });

  final SetupController controller;
  final VoidCallback onContinue;

  @override
  State<_IdentitySetupCard> createState() => _IdentitySetupCardState();
}

final class _IdentitySetupCardState extends State<_IdentitySetupCard> {
  final TextEditingController _handle = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _handle.dispose();
    super.dispose();
  }

  void _createIdentity() {
    final normalized = normalizeDesktopIdentityHandle(_handle.text);
    if (normalized == null) {
      setState(() {
        _error = 'Use 1–48 letters, numbers, dots, dashes, or underscores.';
      });
      return;
    }
    setState(() {
      _error = null;
      _handle.value = TextEditingValue(
        text: normalized,
        selection: TextSelection.collapsed(offset: normalized.length),
      );
    });
    widget.controller.createIdentity(normalized);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final information = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Set up a public Greenways identity',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 7),
        Text(
          'Create a new identity with a public handle, or recover the exact existing identity from its encrypted package and separate recovery-key file. Native file selection and decrypted key material stay outside Flutter, and identity setup may be deferred.',
          style: Theme.of(context).textTheme.bodyMedium
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
        const SizedBox(height: 16),
        TextField(
          key: const Key('identity-handle-field'),
          controller: _handle,
          enabled: !widget.controller.busy,
          inputFormatters: [LengthLimitingTextInputFormatter(50)],
          autocorrect: false,
          enableSuggestions: false,
          textCapitalization: TextCapitalization.none,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _createIdentity(),
          decoration: InputDecoration(
            labelText: 'Public handle',
            hintText: 'river.studio',
            helperText:
                'Lowercase letters, numbers, dots, dashes, and underscores.',
            errorText: _error,
            prefixText: '@',
          ),
        ),
      ],
    );
    final actions = Wrap(
      spacing: 10,
      runSpacing: 10,
      alignment: WrapAlignment.end,
      children: [
        OutlinedButton(
          key: const Key('identity-continue-action'),
          onPressed: widget.controller.busy ? null : widget.onContinue,
          child: const Text('Continue without identity'),
        ),
        OutlinedButton.icon(
          key: const Key('identity-recover-action'),
          onPressed: widget.controller.busy
              ? null
              : widget.controller.recoverIdentity,
          icon: const Icon(Icons.restore_outlined),
          label: const Text('Recover existing identity'),
        ),
        FilledButton.icon(
          key: const Key('identity-create-action'),
          onPressed: widget.controller.busy ? null : _createIdentity,
          icon: widget.controller.busy
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.person_add_alt_outlined),
          label: const Text('Create new identity'),
        ),
      ],
    );
    return Card(
      key: const Key('identity-setup-card'),
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: LayoutBuilder(
          builder: (context, constraints) {
            if (constraints.maxWidth < 700) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [information, const SizedBox(height: 18), actions],
              );
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(child: information),
                const SizedBox(width: 22),
                actions,
              ],
            );
          },
        ),
      ),
    );
  }
}

final class _BrowserCompanionSetupCard extends StatelessWidget {
  const _BrowserCompanionSetupCard({
    required this.controller,
    required this.onContinue,
  });

  final SetupController controller;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final information = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Connect Chrome to this installation',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 7),
        Text(
          'Install the reviewed Chrome stable companion for this macOS user. Desktop uses one fixed extension identity, one self-contained native host, and a separate browser-bridge credential. This remains optional and adds no page forwarding or provider authority.',
          style: Theme.of(context).textTheme.bodyMedium
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
      ],
    );
    final actions = Wrap(
      spacing: 10,
      runSpacing: 10,
      alignment: WrapAlignment.end,
      children: [
        OutlinedButton(
          key: const Key('browser-continue-action'),
          onPressed: controller.busy ? null : onContinue,
          child: const Text('Continue without browser'),
        ),
        FilledButton.icon(
          key: const Key('browser-install-action'),
          onPressed: controller.busy ? null : controller.installBrowserBridge,
          icon: controller.busy
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.extension_outlined),
          label: const Text('Install Chrome companion'),
        ),
      ],
    );
    return Card(
      key: const Key('browser-companion-setup-card'),
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: LayoutBuilder(
          builder: (context, constraints) {
            if (constraints.maxWidth < 700) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [information, const SizedBox(height: 18), actions],
              );
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(child: information),
                const SizedBox(width: 22),
                actions,
              ],
            );
          },
        ),
      ),
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
                    'This build may install or restart only the packaged greenwaysd service, enroll the fixed Desktop client, create or recover one optional public identity, install the exact optional Chrome companion, or repair fixed private modes. Recovery uses native file selection and never sends paths or decrypted key material to Dart. Final connection verification remains unavailable.',
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
