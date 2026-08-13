import 'package:flutter/material.dart';

import '../controller/connection_controller.dart';
import '../model/connection_snapshot.dart';
import 'presentation.dart';
import 'views.dart';

final class DesktopShell extends StatefulWidget {
  const DesktopShell({super.key, required this.controller});

  final ConnectionController controller;

  @override
  State<DesktopShell> createState() => _DesktopShellState();
}

final class _DesktopShellState extends State<DesktopShell> {
  int _destination = 0;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final snapshot = widget.controller.snapshot;
        return LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 760;
            final body = _destination == 0
                ? OverviewView(
                    snapshot: snapshot,
                    controller: widget.controller,
                  )
                : ConnectionsView(
                    snapshot: snapshot,
                    controller: widget.controller,
                  );
            return Scaffold(
              body: SafeArea(
                child: wide
                    ? Row(
                        children: [
                          _DesktopRail(
                            destination: _destination,
                            snapshot: snapshot,
                            onSelected: _select,
                          ),
                          const VerticalDivider(width: 1),
                          Expanded(child: body),
                        ],
                      )
                    : Column(
                        children: [
                          _CompactHeader(snapshot: snapshot),
                          Expanded(child: body),
                        ],
                      ),
              ),
              bottomNavigationBar: wide
                  ? null
                  : NavigationBar(
                      key: const Key('desktop-navigation-bar'),
                      selectedIndex: _destination,
                      onDestinationSelected: _select,
                      destinations: const [
                        NavigationDestination(
                          icon: Icon(Icons.home_outlined),
                          selectedIcon: Icon(Icons.home),
                          label: 'Overview',
                        ),
                        NavigationDestination(
                          icon: Icon(Icons.hub_outlined),
                          selectedIcon: Icon(Icons.hub),
                          label: 'Connections',
                        ),
                      ],
                    ),
            );
          },
        );
      },
    );
  }

  void _select(int destination) {
    setState(() => _destination = destination);
  }
}

final class _DesktopRail extends StatelessWidget {
  const _DesktopRail({
    required this.destination,
    required this.snapshot,
    required this.onSelected,
  });

  final int destination;
  final DesktopConnectionSnapshot snapshot;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      key: const Key('desktop-rail'),
      width: 244,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 24, 18, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Image.asset('assets/greenways-mark.png', width: 42, height: 42),
                const SizedBox(width: 12),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Greenways',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      Text('Desktop', style: TextStyle(fontSize: 13)),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            _StatusPill(snapshot: snapshot),
            const SizedBox(height: 24),
            _RailDestination(
              selected: destination == 0,
              icon: Icons.home_outlined,
              selectedIcon: Icons.home,
              label: 'Overview',
              onTap: () => onSelected(0),
            ),
            const SizedBox(height: 6),
            _RailDestination(
              selected: destination == 1,
              icon: Icons.hub_outlined,
              selectedIcon: Icons.hub,
              label: 'Connections',
              onTap: () => onSelected(1),
            ),
            const Spacer(),
            Text(
              'Local authority stays in greenwaysd.',
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

final class _RailDestination extends StatelessWidget {
  const _RailDestination({
    required this.selected,
    required this.icon,
    required this.selectedIcon,
    required this.label,
    required this.onTap,
  });

  final bool selected;
  final IconData icon;
  final IconData selectedIcon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: selected ? scheme.primaryContainer : Colors.transparent,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          child: Row(
            children: [
              Icon(selected ? selectedIcon : icon),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

final class _CompactHeader extends StatelessWidget {
  const _CompactHeader({required this.snapshot});

  final DesktopConnectionSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 8),
      child: Row(
        children: [
          Image.asset('assets/greenways-mark.png', width: 36, height: 36),
          const SizedBox(width: 10),
          const Expanded(
            child: Text(
              'Greenways Desktop',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
          ),
          _StatusPill(snapshot: snapshot, compact: true),
        ],
      ),
    );
  }
}

final class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.snapshot, this.compact = false});

  final DesktopConnectionSnapshot snapshot;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final state = snapshot.state;
    final scheme = Theme.of(context).colorScheme;
    final connected = state == DesktopConnectionState.connected;
    return Semantics(
      label: 'Daemon status: ${state.title}',
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: compact ? 10 : 12,
          vertical: compact ? 7 : 9,
        ),
        decoration: BoxDecoration(
          color: connected
              ? const Color(0xFFDDEDE5)
              : scheme.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              connected ? Icons.check_circle : state.icon,
              size: 16,
              color: connected
                  ? const Color(0xFF176246)
                  : scheme.onSurfaceVariant,
            ),
            if (!compact) ...[
              const SizedBox(width: 7),
              Flexible(
                child: Text(
                  state.title,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
