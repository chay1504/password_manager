import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

final _secureRandom = Random.secure();

Uint8List randomBytes(int length) => Uint8List.fromList(
  List<int>.generate(length, (_) => _secureRandom.nextInt(256)),
);

class VaultCrypto {
  static const _associatedData = 'TBD-VAULT-v1';
  static final _cipher = AesGcm.with256bits();

  static Future<String> encrypt(List<int> plaintext, List<int> key) async {
    if (key.length != 32) throw ArgumentError('Vault key must be 32 bytes');
    final nonce = randomBytes(12);
    final box = await _cipher.encrypt(
      plaintext,
      secretKey: SecretKey(key),
      nonce: nonce,
      aad: utf8.encode(_associatedData),
    );
    return jsonEncode({
      'format': _associatedData,
      'nonce': base64Encode(nonce),
      'ciphertext': base64Encode(box.cipherText),
      'mac': base64Encode(box.mac.bytes),
    });
  }

  static Future<Uint8List> decrypt(String document, List<int> key) async {
    if (key.length != 32) throw ArgumentError('Vault key must be 32 bytes');
    final outer = jsonDecode(document) as Map<String, dynamic>;
    if (outer['format'] != _associatedData) {
      throw const FormatException('Unsupported vault file');
    }
    final nonce = base64Decode(outer['nonce'] as String);
    final mac = base64Decode(outer['mac'] as String);
    if (nonce.length != 12 || mac.length != 16) {
      throw const FormatException('Invalid vault file');
    }
    final clear = await _cipher.decrypt(
      SecretBox(
        base64Decode(outer['ciphertext'] as String),
        nonce: nonce,
        mac: Mac(mac),
      ),
      secretKey: SecretKey(key),
      aad: utf8.encode(_associatedData),
    );
    return Uint8List.fromList(clear);
  }
}
