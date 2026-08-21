import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenways_desktop/controller/connection_controller.dart';
import 'package:greenways_desktop/model/connection_snapshot.dart';
import 'package:greenways_desktop/model/setup_snapshot.dart';
import 'package:greenways_desktop/services/desktop_bridge.dart';
import 'package:greenways_desktop/services/desktop_control_server.dart';

import 'support/fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('binds a private socket and returns the exact redacted snapshot', () async {
    final fixture = await _Fixture.start();
    addTearDown(fixture.close);

    final response = await fixture.request('status');

    expect(response.keys.toSet(), {
      'protocol',
      'requestId',
      'outcome',
      'snapshot',
      'error',
    });
    expect(response['protocol'], desktopControlResultProtocol);
    expect(response['outcome'], 'ok');
    final snapshot = _object(response['snapshot']);
    expect(snapshot['protocol'], desktopConnectionStatusProtocol);
    expect(snapshot['state'], 'disconnected');
    expect(jsonEncode(response), isNot(contains('credential')));
    expect(jsonEncode(response), isNot(contains('local/session/')));

    final path = fixture.server.socketPath!;
    final stat = await FileStat.stat(path);
    expect(stat.type, FileSystemEntityType.unixDomainSock);
    expect(stat.mode & 0x1ff, 0x180);
    final runStat = await FileStat.stat(Directory(path).parent.path);
    expect(runStat.mode & 0x1ff, 0x1c0);
  });

  test('rejects unknown request fields and commands', () async {
    final fixture = await _Fixture.start();
    addTearDown(fixture.close);

    final unknownFieldId = fixture.nextRequestId();
    final unknownField = await fixture.rawRequest({
      'protocol': desktopControlProtocol,
      'requestId': unknownFieldId,
      'command': 'status',
      'setup': true,
    });
    expect(unknownField['requestId'], unknownFieldId);
    expect(unknownField['outcome'], 'error');
    expect(_object(unknownField['error'])['code'], 'invalid-request');

    final unknownCommandId = fixture.nextRequestId();
    final unknownCommand = await fixture.rawRequest({
      'protocol': desktopControlProtocol,
      'requestId': unknownCommandId,
      'command': 'provider.invoke',
    });
    expect(unknownCommand['requestId'], unknownCommandId);
    expect(unknownCommand['outcome'], 'error');
    expect(_object(unknownCommand['error'])['code'], 'invalid-request');
  });

  test('routes visible connection changes through ConnectionController', () async {
    final bridge = FakeDesktopBridge();
    final fixture = await _Fixture.start(bridge: bridge);
    addTearDown(fixture.close);

    final connected = await fixture.request('connect');
    expect(bridge.connects, 1);
    expect(_object(connected['snapshot'])['state'], 'connected');

    final refreshed = await fixture.request('refresh');
    expect(bridge.refreshes, 1);
    expect(_object(refreshed['snapshot'])['state'], 'connected');

    final disconnected = await fixture.request('disconnect');
    expect(bridge.disconnects, 1);
    expect(_object(disconnected['snapshot'])['state'], 'disconnected');
  });

  test('serializes commands and returns desktop-busy for overlap', () async {
    final bridge = _BlockingDesktopBridge();
    final fixture = await _Fixture.start(bridge: bridge);
    addTearDown(fixture.close);

    final first = fixture.request('connect');
    await bridge.connectStarted.future;
    final busy = await fixture.request('status');
    expect(busy['outcome'], 'error');
    expect(_object(busy['error'])['code'], 'desktop-busy');

    bridge.connectResult.complete(connectedSnapshot());
    final connected = await first;
    expect(connected['outcome'], 'ok');
    expect(_object(connected['snapshot'])['state'], 'connected');
  });

  test('show-window and quit remain low-authority ordered actions', () async {
    var shows = 0;
    var quitCalled = false;
    final responseObserved = Completer<void>();
    final fixture = await _Fixture.start(
      showWindow: () async {
        shows += 1;
      },
      quit: () async {
        await responseObserved.future.timeout(const Duration(seconds: 2));
        quitCalled = true;
      },
    );
    addTearDown(fixture.close);

    final shown = await fixture.request('show-window');
    expect(shown['outcome'], 'ok');
    expect(shows, 1);

    final quitResponse = await fixture.request(
      'quit',
      onResponse: () => responseObserved.complete(),
    );
    expect(quitResponse['outcome'], 'ok');
    await Future<void>.delayed(Duration.zero);
    expect(quitCalled, isTrue);
  });

  test('refuses unsafe stale entries instead of replacing them', () async {
    final home = await Directory.systemTemp.createTemp('greenways-control-unsafe-');
    addTearDown(() => home.delete(recursive: true));
    final run = Directory('${home.path}/run');
    await run.create();
    final path = '${run.path}/$desktopControlSocketName';
    await File(path).writeAsString('not a socket');
    final controller = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    addTearDown(controller.dispose);
    final server = DesktopControlServer(
      controller,
      home: home.path,
      showWindow: () async {},
      quit: () async {},
    );

    await expectLater(server.start(), throwsA(isA<FileSystemException>()));
    expect(await File(path).readAsString(), 'not a socket');
  });

  test('removes only its owned socket on clean shutdown', () async {
    final fixture = await _Fixture.start();
    final path = fixture.server.socketPath!;
    expect(await FileSystemEntity.type(path), FileSystemEntityType.unixDomainSock);

    await fixture.server.close();

    expect(
      await FileSystemEntity.type(path, followLinks: false),
      FileSystemEntityType.notFound,
    );
    await fixture.close();
  });
}

final class _Fixture {
  _Fixture({
    required this.home,
    required this.controller,
    required this.server,
  });

  final Directory home;
  final ConnectionController controller;
  final DesktopControlServer server;
  int _sequence = 0;

  static Future<_Fixture> start({
    DesktopBridge? bridge,
    Future<void> Function()? showWindow,
    Future<void> Function()? quit,
  }) async {
    final home = await Directory.systemTemp.createTemp('greenways-control-');
    final controller = ConnectionController(
      bridge ?? FakeDesktopBridge(),
      autoRefresh: false,
    );
    final server = DesktopControlServer(
      controller,
      home: home.path,
      showWindow: showWindow ?? () async {},
      quit: quit ?? () async {},
    );
    await server.start();
    return _Fixture(home: home, controller: controller, server: server);
  }

  String nextRequestId() {
    _sequence += 1;
    return 'desktop/control/test-${_sequence.toString().padLeft(8, '0')}';
  }

  Future<Map<String, Object?>> request(
    String command, {
    void Function()? onResponse,
  }) => rawRequest({
    'protocol': desktopControlProtocol,
    'requestId': nextRequestId(),
    'command': command,
  }, onResponse: onResponse);

  Future<Map<String, Object?>> rawRequest(
    Map<String, Object?> request, {
    void Function()? onResponse,
  }) async {
    final socket = await Socket.connect(
      InternetAddress(server.socketPath!, type: InternetAddressType.unix),
      0,
    );
    socket.add(utf8.encode('${jsonEncode(request)}\n'));
    await socket.flush();
    final responseFuture = utf8.decoder.bind(socket.cast<List<int>>()).join();
    await socket.close();
    final response = await responseFuture;
    onResponse?.call();
    final lines = const LineSplitter().convert(response);
    expect(lines, hasLength(1));
    return _object(jsonDecode(lines.single));
  }

  Future<void> close() async {
    await server.close();
    controller.dispose();
    if (await home.exists()) await home.delete(recursive: true);
  }
}

final class _BlockingDesktopBridge implements DesktopBridge {
  final Completer<void> connectStarted = Completer<void>();
  final Completer<DesktopConnectionSnapshot> connectResult =
      Completer<DesktopConnectionSnapshot>();

  @override
  Future<DesktopConnectionSnapshot> connect() {
    connectStarted.complete();
    return connectResult.future;
  }

  @override
  Future<DesktopConnectionSnapshot> refresh() async => connectedSnapshot();

  @override
  Future<DesktopConnectionSnapshot> disconnect() async =>
      DesktopConnectionSnapshot.disconnected();

  @override
  Future<DesktopSetupSnapshot> performSetup(
    DesktopSetupOperation operation, {
    String? handle,
  }) async => inspectedSetupSnapshot();

  @override
  Future<void> close() async {}
}

Map<String, Object?> _object(Object? value) {
  if (value is! Map) throw StateError('Expected a JSON object.');
  return value.map((key, entry) {
    if (key is! String) throw StateError('Expected text JSON keys.');
    return MapEntry(key, entry);
  });
}
