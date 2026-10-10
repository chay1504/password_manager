import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:tbd_core/tbd_core.dart';
import 'package:tbd_platform/tbd_platform.dart';
import 'package:tbd_vault/vault_controller.dart';

class _FakeSecrets implements DeviceSecrets {
  final values = <String, Uint8List>{};

  @override
  Future<Uint8List?> read(String name) async => values[name];

  @override
  Future<void> write(String name, List<int> bytes) async =>
      values[name] = Uint8List.fromList(bytes);

  @override
  Future<void> delete(String name) async => values.remove(name);
}

class _FakePairing implements PrivatePairing {
  Uint8List? secret;
  int? period;

  @override
  Future<void> publish(List<int> secret, int period) async {
    this.secret = Uint8List.fromList(secret);
    this.period = period;
  }

  @override
  Future<PairingData?> consume() async => null;

  @override
  Future<int?> readPeriod() async => period;

  @override
  Future<void> writePeriod(int period) async => this.period = period;
}

void main() {
  late Directory folder;
  late _FakeSecrets secrets;
  late _FakePairing pairing;
  late DateTime now;

  // Start 3 seconds into a 10-second step so there is room before it ends.
  DateTime stepStart(int step, int period) =>
      DateTime.fromMillisecondsSinceEpoch(step * period * 1000, isUtc: true);

  VaultController newController() => VaultController(
    secrets: secrets,
    pairing: pairing,
    clock: () => now,
    storageFolder: () async => folder,
  );

  String codeNow([DateTime? at, int? period]) =>
      Otp.code(pairing.secret!, at ?? now, period ?? pairing.period!);

  Future<VaultController> createdVault() async {
    final controller = newController();
    await controller.initialize();
    await controller.create();
    expect(controller.phase, VaultPhase.code);
    return controller;
  }

  setUp(() async {
    folder = await Directory.systemTemp.createTemp('tbd-controller-test-');
    secrets = _FakeSecrets();
    pairing = _FakePairing();
    now = stepStart(1000, 10).add(const Duration(seconds: 3));
  });

  tearDown(() async {
    await folder.delete(recursive: true);
  });

  test('correct current code opens the vault', () async {
    final controller = await createdVault();
    expect(await controller.verifyCode(codeNow()), isTrue);
    expect(controller.phase, VaultPhase.open);
  });

  test('wrong, short and non-numeric codes are rejected', () async {
    final controller = await createdVault();
    final good = codeNow();
    final wrong = good == '00000000' ? '11111111' : '00000000';
    for (final input in [wrong, '1234567', '123456789', 'abcdefgh', '']) {
      expect(await controller.verifyCode(input), isFalse, reason: input);
      expect(controller.phase, VaultPhase.code);
    }
  });

  test('a code from the previous interval has expired', () async {
    final controller = await createdVault();
    final old = codeNow(now.subtract(const Duration(seconds: 10)));
    now = now.add(const Duration(seconds: 5)); // 8 s into step N, old is N-1
    expect(old, isNot(codeNow()));
    expect(await controller.verifyCode(old), isFalse);
    expect(controller.phase, VaultPhase.code);
    expect(await controller.verifyCode(codeNow()), isTrue);
  });

  test('five wrong tries lock out entry, even for the right code', () async {
    final controller = await createdVault();
    for (var i = 0; i < 5; i++) {
      expect(await controller.verifyCode('00000000'), isFalse);
    }
    expect(controller.message, contains('Wait 30 seconds'));
    expect(await controller.verifyCode(codeNow()), isFalse);
    expect(controller.message, contains('Wait'));
    expect(controller.phase, VaultPhase.code);

    now = now.add(const Duration(seconds: 31));
    expect(await controller.verifyCode(codeNow()), isTrue);
  });

  test('lockout survives an app restart', () async {
    final first = await createdVault();
    for (var i = 0; i < 5; i++) {
      await first.verifyCode('00000000');
    }
    final restarted = newController();
    await restarted.initialize();
    expect(restarted.phase, VaultPhase.locked);
    await restarted.unlockDevice();
    expect(restarted.phase, VaultPhase.code);
    expect(await restarted.verifyCode(codeNow()), isFalse);
    expect(restarted.message, contains('Wait'));
  });

  test('a corrupt attempts file is treated as a lockout', () async {
    final controller = await createdVault();
    await File('${folder.path}/attempts.json').writeAsString('not json');
    expect(await controller.verifyCode(codeNow()), isFalse);
    expect(controller.message, contains('Wait'));
  });

  test('an accepted code cannot be replayed in the same interval', () async {
    final controller = await createdVault();
    final code = codeNow();
    expect(await controller.verifyCode(code), isTrue);

    controller.lock();
    expect(controller.phase, VaultPhase.locked);
    await controller.unlockDevice();
    expect(controller.phase, VaultPhase.code);
    expect(await controller.verifyCode(code), isFalse);

    // Same replay after a full restart of the controller.
    final restarted = newController();
    await restarted.initialize();
    await restarted.unlockDevice();
    expect(await restarted.verifyCode(code), isFalse);

    // The next interval's code is accepted.
    now = now.add(const Duration(seconds: 10));
    expect(await restarted.verifyCode(codeNow()), isTrue);
  });

  test('a period changed in TBD Codes is picked up before checking', () async {
    final controller = await createdVault();
    pairing.period = 5;
    now = stepStart(2000, 5).add(const Duration(seconds: 1));
    expect(await controller.verifyCode(codeNow()), isTrue);
  });

  test('locking clears decrypted data', () async {
    final controller = await createdVault();
    await controller.verifyCode(codeNow());
    expect(controller.data, isNotNull);
    controller.lock();
    expect(controller.data, isNull);
    expect(controller.phase, VaultPhase.locked);
  });

  test('vault file on disk does not contain the secret in clear', () async {
    await createdVault();
    final text = await File('${folder.path}/vault.tbd').readAsString();
    expect(text, isNot(contains(base64Encode(pairing.secret!))));
  });
}
