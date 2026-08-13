import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../controller/connection_controller.dart';
import '../model/connection_snapshot.dart';
import 'presentation.dart';

final class OverviewView extends StatelessWidget {
  const OverviewView({
    super.key,
    required this.snapshot,
    required this.controller,
  });

  final DesktopConnectionSnapshot snapshot;
  final ConnectionController controller;

  @override
  Widget build(BuildContext context) {
    return _PageFrame(
      eyebrow: 'LOCAL CONTROL PLANE',
      title: 'Overview',
      subtitle: 'Connection health for this Greenways installation.',
      children: [
        _ConnectionHero(snapshot: snapshot, controller: controller),
        const SizedBox(height: 18),
        _StageCard(snapshot: snapshot),
        const SizedBox(height: 18),
        LayoutBuilder(
          builder: (context, constraints) {
            final columns = constraints.maxWidth >= 900 ? 3 : 1;
            final cards = [
              _HealthCard(
                icon: Icons.dns_outlined,
                title: 'Daemon',
                value: snapshot.daemon == null
                    ? 'Not available'
                    : 'Generation ${snapshot.daemon!.generation}',
                detail:
                    snapshot.daemon?.nodeId ??
                    'Connect to read this installation’s node identity.',
              ),
              _HealthCard(
                icon: Icons.verified_user_outlined,
                title: 'Public identity',
                value: snapshot.identity?.handle ?? 'Not configured',
                detail: snapshot.identity?.keyId ?? 'The daemon can be connected before profile identity is created.',
              ),
              _HealthCard(
                icon: Icons.schedule_outlined,
                title: 'Local session',
                value: snapshot.session == null
                    ? 'Inactive'
                    : '${snapshot.session!.remainingRequests} requests remain',
                detail: snapshot.session == null
                    ? 'Reconnect to open a new connection-bound session.'
                    : 'Expires ${_formatTime(snapshot.session!.expiresAtUnixMs)}',
              ),
            ];
            if (columns == 1) {
              return Column(
                children: [
                  for (var index = 0; index < cards.length; index++) ...[
                    cards[index],
                    if (index != cards.length - 1) const SizedBox(height: 12),
                  ],
                ],
              );
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var index = 0; index < cards.length; index++) ...[
                  Expanded(child: cards[index]),
                  if (index != cards.length - 1) const SizedBox(width: 12),
                ],
              ],
            );
          },
        ),
      ],
    );
  }
}

final class ConnectionsView extends StatelessWidget {
  const ConnectionsView({
    super.key,
    required this.snapshot,
    required this.controller,
  });

  final DesktopConnectionSnapshot snapshot;
  final ConnectionController controller;

  @override
  Widget build(BuildContext context) {
    return _PageFrame(
      eyebrow: 'GREENWAYSD',
      title: 'Connections',
      subtitle: 'A direct Desktop session. Chrome is not in this path.',
      children: [
        _ConnectionHero(snapshot: snapshot, controller: controller),
        const SizedBox(height: 18),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(22),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Connection details',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 16),
                _DetailRow(
                  label: 'Node',
                  value: snapshot.daemon?.nodeId ?? '—',
                ),
                _DetailRow(
                  label: 'Daemon',
                  value: snapshot.daemon == null
                      ? '—'
                      : '${snapshot.daemon!.daemonVersion} · generation ${snapshot.daemon!.generation}',
                ),
                _DetailRow(
                  label: 'Desktop actor',
                  value: snapshot.actor == null
                      ? '—'
                      : '${snapshot.actor!.label} · ${snapshot.actor!.role}',
                ),
                _DetailRow(
                  label: 'Identity',
                  value: snapshot.identity == null
                      ? 'Not configured'
                      : '${snapshot.identity!.handle} · ${snapshot.identity!.keyId}',
                ),
                _DetailRow(
                  label: 'Session',
                  value: snapshot.session == null
                      ? '—'
                      : 'Expires ${_formatTime(snapshot.session!.expiresAtUnixMs)} · '
                            '${snapshot.session!.remainingRequests} requests remain',
                  last: true,
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 18),
        _GuidanceCard(snapshot: snapshot),
        const SizedBox(height: 18),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(22),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.content_copy_outlined),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Redacted diagnostics',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Copy only the bounded public connection snapshot. Credentials, private keys, provider handles and daemon session IDs are not projected.',
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 14),
                OutlinedButton.icon(
                  onPressed: () async {
                    await Clipboard.setData(
                      ClipboardData(text: controller.diagnosticsJson()),
                    );
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Redacted diagnostics copied.'),
                      ),
                    );
                  },
                  icon: const Icon(Icons.copy),
                  label: const Text('Copy'),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

final class RoomsView extends StatelessWidget {
  const RoomsView({super.key, required this.snapshot});

  final DesktopConnectionSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final imported = snapshot.hestiaImport;
    return KeyedSubtree(
      key: const Key('rooms-view'),
      child: _PageFrame(
        eyebrow: 'HESTIA AUTHORITY',
        title: 'Rooms',
        subtitle: 'Compiled import readiness without inferring room authority or membership.',
        children: imported == null
            ? const [_RoomsConnectionRequired()]
            : [
                LayoutBuilder(
                  builder: (context, constraints) {
                    final readiness = _HestiaImportReadiness(
                      imported: imported,
                    );
                    const ownership = _RoomOwnershipBoundary();
                    if (constraints.maxWidth < 820) {
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          readiness,
                          const SizedBox(height: 16),
                          ownership,
                        ],
                      );
                    }
                    return Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(child: readiness),
                        const SizedBox(width: 16),
                        const Expanded(child: ownership),
                      ],
                    );
                  },
                ),
                const SizedBox(height: 18),
                _RoomsEmptyState(imported: imported),
                const SizedBox(height: 18),
                const _RoomAuthorityStages(),
              ],
      ),
    );
  }
}

final class _RoomsConnectionRequired extends StatelessWidget {
  const _RoomsConnectionRequired();

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              Icons.link_off,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Connection required',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Connect to greenwaysd to read this build’s pinned Hestia import readiness.',
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Desktop infers no room, membership, source mandate, application grant or availability while disconnected.',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
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

final class _HestiaImportReadiness extends StatelessWidget {
  const _HestiaImportReadiness({required this.imported});

  final DesktopHestiaImportProjection imported;

  @override
  Widget build(BuildContext context) {
    return Card(
      key: const Key('hestia-import-ready'),
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.inventory_2_outlined),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'Pinned import ready',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                const SizedBox(width: 8),
                Chip(label: Text(imported.verificationScope)),
              ],
            ),
            const SizedBox(height: 18),
            _DetailRow(label: 'Repository', value: imported.repository),
            _DetailRow(label: 'Package', value: imported.package),
            _DetailRow(
              label: 'Revision',
              value: '${imported.revision.substring(0, 12)}…',
            ),
            _DetailRow(
              label: 'Artifacts',
              value: '${imported.artifactCount} reviewed artifacts',
              last: true,
            ),
          ],
        ),
      ),
    );
  }
}

final class _RoomOwnershipBoundary extends StatelessWidget {
  const _RoomOwnershipBoundary();

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.account_tree_outlined),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'Ownership boundary',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),
            const _BoundaryRow(
              owner: 'Hestia',
              responsibility: 'Room governance, membership, epochs, source mandates and canonical receipts.',
            ),
            const SizedBox(height: 14),
            const _BoundaryRow(
              owner: 'Greenways',
              responsibility: 'Installation-local custody, verified imports, bounded projections and local execution.',
            ),
          ],
        ),
      ),
    );
  }
}

final class _BoundaryRow extends StatelessWidget {
  const _BoundaryRow({required this.owner, required this.responsibility});

  final String owner;
  final String responsibility;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 82,
          child: Text(
            owner,
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            responsibility,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}

final class _RoomsEmptyState extends StatelessWidget {
  const _RoomsEmptyState({required this.imported});

  final DesktopHestiaImportProjection imported;

  @override
  Widget build(BuildContext context) {
    return Card(
      key: const Key('rooms-empty-state'),
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(14),
              ),
              alignment: Alignment.center,
              child: Text(
                imported.admittedRoomProjectionCount.toString(),
                style: Theme.of(context).textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'No room projections admitted',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 7),
                  Text(
                    'The exact Hestia package closure is pinned, but no canonical room projection has crossed into this installation.',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
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

final class _RoomAuthorityStages extends StatelessWidget {
  const _RoomAuthorityStages();

  @override
  Widget build(BuildContext context) {
    const stages = [
      (
        'Hestia package pinned',
        true,
        'The reviewed package closure is compiled into this build.',
      ),
      (
        'Room projection admitted',
        false,
        'No canonical room projection has been admitted.',
      ),
      (
        'Membership active',
        false,
        'No membership is inferred from package readiness.',
      ),
      (
        'Source mandated',
        false,
        'No room-owned application source has been selected.',
      ),
      (
        'Room application granted',
        false,
        'No room application authority has been projected.',
      ),
      (
        'Source available',
        false,
        'No local route or provider availability is implied.',
      ),
    ];
    return Card(
      key: const Key('rooms-authority-stages'),
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Authority stages',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 7),
            Text(
              'Each boundary becomes active only from explicit Hestia evidence and Greenways admission.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 18),
            for (var index = 0; index < stages.length; index++)
              _StageRow(
                title: stages[index].$1,
                complete: stages[index].$2,
                detail: stages[index].$3,
                last: index == stages.length - 1,
              ),
          ],
        ),
      ),
    );
  }
}

final class _PageFrame extends StatelessWidget {
  const _PageFrame({
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

final class _ConnectionHero extends StatelessWidget {
  const _ConnectionHero({required this.snapshot, required this.controller});

  final DesktopConnectionSnapshot snapshot;
  final ConnectionController controller;

  @override
  Widget build(BuildContext context) {
    final state = snapshot.state;
    final connected = state == DesktopConnectionState.connected;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final compact = constraints.maxWidth < 650;
            final information = Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                    color: connected
                        ? const Color(0xFFDDEDE5)
                        : Theme.of(context).colorScheme.surfaceContainerHigh,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Icon(
                    connected ? Icons.check_circle : state.icon,
                    color: connected ? const Color(0xFF176246) : null,
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        state.title,
                        style: Theme.of(context).textTheme.headlineSmall
                            ?.copyWith(fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        _stateDescription(snapshot),
                        style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
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
            final actions = _ConnectionActions(
              snapshot: snapshot,
              controller: controller,
            );
            if (compact) {
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

final class _ConnectionActions extends StatelessWidget {
  const _ConnectionActions({required this.snapshot, required this.controller});

  final DesktopConnectionSnapshot snapshot;
  final ConnectionController controller;

  @override
  Widget build(BuildContext context) {
    if (snapshot.isConnected) {
      return Wrap(
        spacing: 10,
        runSpacing: 10,
        alignment: WrapAlignment.end,
        children: [
          OutlinedButton.icon(
            onPressed: controller.busy ? null : controller.refresh,
            icon: const Icon(Icons.refresh),
            label: const Text('Refresh'),
          ),
          OutlinedButton.icon(
            onPressed: controller.busy ? null : controller.disconnect,
            icon: const Icon(Icons.link_off),
            label: const Text('Disconnect'),
          ),
        ],
      );
    }
    final reconnect =
        snapshot.state != DesktopConnectionState.disconnected &&
        snapshot.state != DesktopConnectionState.connecting;
    return FilledButton.icon(
      onPressed: controller.busy
          ? null
          : reconnect
          ? controller.reconnect
          : controller.connect,
      icon: controller.busy
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(reconnect ? Icons.sync : Icons.link),
      label: Text(reconnect ? 'Reconnect' : 'Connect'),
    );
  }
}

final class _StageCard extends StatelessWidget {
  const _StageCard({required this.snapshot});

  final DesktopConnectionSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final stages = [
      ('Desktop installed', true, 'This application is running.'),
      ('Daemon reachable', snapshot.daemon != null, 'Private local socket.'),
      (
        'Desktop authenticated',
        snapshot.actor != null,
        'Role fixed by greenwaysd.',
      ),
      (
        'Public identity verified',
        snapshot.identity != null,
        'Optional until configured.',
      ),
      (
        'Session active',
        snapshot.session != null,
        'Connection-bound and expiring.',
      ),
    ];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Connection path',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 16),
            for (var index = 0; index < stages.length; index++)
              _StageRow(
                title: stages[index].$1,
                complete: stages[index].$2,
                detail: stages[index].$3,
                last: index == stages.length - 1,
              ),
          ],
        ),
      ),
    );
  }
}

final class _StageRow extends StatelessWidget {
  const _StageRow({
    required this.title,
    required this.complete,
    required this.detail,
    required this.last,
  });

  final String title;
  final bool complete;
  final String detail;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final activeColor = Theme.of(context).colorScheme.primary;
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 32,
            child: Column(
              children: [
                Icon(
                  complete ? Icons.check_circle : Icons.radio_button_unchecked,
                  size: 20,
                  color: complete
                      ? activeColor
                      : Theme.of(context).colorScheme.outline,
                ),
                if (!last)
                  Expanded(
                    child: Container(
                      width: 2,
                      margin: const EdgeInsets.symmetric(vertical: 4),
                      color: Theme.of(context).colorScheme.outlineVariant,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: last ? 0 : 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    detail,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

final class _HealthCard extends StatelessWidget {
  const _HealthCard({
    required this.icon,
    required this.title,
    required this.value,
    required this.detail,
  });

  final IconData icon;
  final String title;
  final String value;
  final String detail;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: Theme.of(context).colorScheme.secondary),
            const SizedBox(height: 16),
            Text(title, style: Theme.of(context).textTheme.labelLarge),
            const SizedBox(height: 5),
            Text(
              value,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            Text(
              detail,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

final class _GuidanceCard extends StatelessWidget {
  const _GuidanceCard({required this.snapshot});

  final DesktopConnectionSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final guidance = switch (snapshot.state) {
      DesktopConnectionState.credentialUnavailable => (
        'Enrol Greenways Desktop',
        'Stop greenwaysd, issue one private Desktop credential, then reconnect.',
        'greenways-admin --state-dir ~/.greenways client issue --role desktop '
            '--output ~/.greenways/clients/desktop.json',
      ),
      DesktopConnectionState.daemonUnavailable => (
        'Start greenwaysd',
        'Desktop connects only to the private local daemon socket.',
        '~/.greenways/run/greenwaysd.sock',
      ),
      DesktopConnectionState.authenticationRejected => (
        'Replace the revoked or wrong-role credential',
        'The local role is fixed by the daemon registry and cannot be supplied by Flutter.',
        'greenways-admin --state-dir ~/.greenways client list',
      ),
      DesktopConnectionState.sessionExpired => (
        'Reconnect the local session',
        'Sessions are connection-bound, expire after a bounded lifetime and are never persisted in Flutter.',
        'Use Reconnect above.',
      ),
      DesktopConnectionState.protocolUpgradeRequired => (
        'Update Greenways Desktop and greenwaysd together',
        'The local protocols do not share a supported version.',
        'No compatibility authority fallback is enabled.',
      ),
      DesktopConnectionState.bridgeUnavailable => (
        'Repair the Desktop installation',
        'The signed app bundle is missing its dedicated Rust companion.',
        'Reinstall Greenways Desktop from the release package.',
      ),
      _ => (
        'Local-only connection',
        'Desktop talks directly to greenwaysd. The browser Native Messaging bridge is not involved.',
        'No provider or room authority is exposed by this screen.',
      ),
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(snapshot.state.icon),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    guidance.$1,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 7),
                  Text(guidance.$2),
                  const SizedBox(height: 12),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(13),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surfaceContainerLow,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: SelectableText(
                      guidance.$3,
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12,
                      ),
                    ),
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

final class _DetailRow extends StatelessWidget {
  const _DetailRow({
    required this.label,
    required this.value,
    this.last = false,
  });

  final String label;
  final String value;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: last ? 0 : 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: SelectableText(
              value,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5),
            ),
          ),
        ],
      ),
    );
  }
}

String _stateDescription(DesktopConnectionSnapshot snapshot) {
  if (snapshot.isConnected && snapshot.identity == null) {
    return 'The daemon session is active. Public profile identity still needs to be configured.';
  }
  return switch (snapshot.state) {
    DesktopConnectionState.connecting =>
      'Opening an authenticated, connection-bound Desktop session.',
    DesktopConnectionState.connected =>
      'This app is authenticated directly to the local Greenways daemon.',
    DesktopConnectionState.daemonUnavailable =>
      'The private local daemon socket is not reachable.',
    DesktopConnectionState.credentialUnavailable =>
      'A private enrolled Desktop credential has not been configured.',
    DesktopConnectionState.authenticationRejected =>
      'The daemon rejected this local client or its fixed role.',
    DesktopConnectionState.sessionExpired =>
      'The bounded local session is no longer active.',
    DesktopConnectionState.protocolUpgradeRequired =>
      'Desktop and greenwaysd do not share a supported local protocol.',
    DesktopConnectionState.bridgeUnavailable =>
      'The app’s dedicated Rust companion could not be started.',
    DesktopConnectionState.disconnected =>
      'No authority is active in the Desktop process.',
  };
}

String _formatTime(int milliseconds) {
  final time = DateTime.fromMillisecondsSinceEpoch(milliseconds).toLocal();
  String two(int value) => value.toString().padLeft(2, '0');
  return '${time.year}-${two(time.month)}-${two(time.day)} '
      '${two(time.hour)}:${two(time.minute)}:${two(time.second)}';
}
