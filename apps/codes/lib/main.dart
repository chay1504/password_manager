import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:tbd_core/tbd_core.dart';
import 'package:tbd_platform/tbd_platform.dart';

const _ink = Color(0xff080808);
const _paper = Color(0xfff4f1ec);
const _red = Color(0xfff22d1c);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CodesApp());
}

class CodesApp extends StatelessWidget {
  const CodesApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'TBD Codes',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: _ink,
      colorScheme: const ColorScheme.dark(
        primary: _red,
        surface: Color(0xff111111),
        onSurface: _paper,
      ),
      fontFamily: 'Manrope',
    ),
    home: const CodesHome(),
  );
}

class CodesHome extends StatefulWidget {
  const CodesHome({super.key});

  @override
  State<CodesHome> createState() => _CodesHomeState();
}

class _CodesHomeState extends State<CodesHome> with WidgetsBindingObserver {
  final _secrets = DeviceSecrets();
  final _pairing = PrivatePairing();
  final _clipboard = SecureClipboard();
  Uint8List? _secret;
  Timer? _ticker;
  String? _message;
  bool _busy = false;
  int _period = 10;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
      if (mounted && _secret != null) setState(() => _now = DateTime.now());
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    assert(() {
      debugPrint('TBD Codes lifecycle: $state');
      return true;
    }());
    if (state == AppLifecycleState.resumed) _clipboard.clearIfStillCopied();
    if ((state == AppLifecycleState.paused ||
            state == AppLifecycleState.hidden ||
            state == AppLifecycleState.detached) &&
        mounted) {
      setState(() => _secret = null);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _ticker?.cancel();
    _clipboard.dispose();
    super.dispose();
  }

  Future<void> _unlock() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = 'Unlocking with phone…';
    });
    try {
      assert(() {
        debugPrint('TBD Codes protected read start');
        return true;
      }());
      final secret = await _secrets.read('otpSeed');
      assert(() {
        debugPrint('TBD Codes protected read completed');
        return true;
      }());
      if (secret == null) {
        throw StateError('Not paired yet. Start pairing in TBD Vault.');
      }
      final period = await _pairing.readPeriod() ?? 10;
      if (!mounted) return;
      setState(() {
        _secret = secret;
        _period = period;
        _now = DateTime.now();
      });
    } catch (error) {
      if (mounted) setState(() => _message = _friendly(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pair() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final record = await _pairing.consume();
      if (record == null) {
        throw StateError(
          'No pairing request. Open TBD Vault and tap Pair Codes.',
        );
      }
      await _secrets.write('otpSeed', record.secret);
      if (!mounted) return;
      setState(() {
        _period = record.period;
        _secret = null;
        _message =
            'Paired. Unlock saved codes with your phone to reveal the code.';
      });
    } catch (error) {
      if (mounted) setState(() => _message = _friendly(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _changePeriod(int value) async {
    try {
      await _pairing.writePeriod(value);
      if (mounted) setState(() => _period = value);
    } catch (error) {
      if (mounted) setState(() => _message = _friendly(error));
    }
  }

  Future<void> _copy(String code) async {
    await _clipboard.copy(code, expiry: const Duration(seconds: 15));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Code copied. Paste it into TBD Vault now.'),
      ),
    );
  }

  String _friendly(Object error) {
    if (error is StateError) return error.message;
    return 'Could not access protected codes. Check your phone lock and try again.';
  }

  @override
  Widget build(BuildContext context) {
    final secret = _secret;
    final code = secret == null ? null : Otp.code(secret, _now, _period);
    final remaining = Otp.secondsLeft(_now, _period);
    return Scaffold(
      appBar: AppBar(
        backgroundColor: _ink,
        title: const Text(
          'TBD CODES',
          style: TextStyle(
            fontFamily: 'Bebas Neue',
            fontSize: 29,
            letterSpacing: 1.5,
          ),
        ),
        actions: [
          if (secret != null)
            IconButton(
              tooltip: 'Lock codes',
              onPressed: () => setState(() => _secret = null),
              icon: const Icon(Icons.lock_outline),
            ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'YOUR SECOND KEY',
                style: TextStyle(
                  color: _red,
                  letterSpacing: 2,
                  fontFamily: 'IBM Plex Mono',
                  fontSize: 12,
                ),
              ),
              const SizedBox(height: 15),
              Text(
                secret == null
                    ? 'A code that stays on this phone.'
                    : 'Use this code to open your vault.',
                style: const TextStyle(
                  fontFamily: 'Bebas Neue',
                  fontSize: 42,
                  height: 0.98,
                ),
              ),
              const SizedBox(height: 30),
              if (secret == null) ...[
                _panel(
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(Icons.timer_outlined, color: _red, size: 42),
                      const SizedBox(height: 20),
                      const Text(
                        'Pair once with TBD Vault. Then unlock this app with your phone’s fingerprint, Face ID, or passcode.',
                      ),
                      const SizedBox(height: 24),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton(
                          onPressed: _busy ? null : _pair,
                          child: const Text('PAIR WITH VAULT'),
                        ),
                      ),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton(
                          onPressed: _busy ? null : _unlock,
                          child: const Text('UNLOCK SAVED CODES'),
                        ),
                      ),
                    ],
                  ),
                ),
              ] else ...[
                _panel(
                  Column(
                    children: [
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          'CHANGES IN $remaining S',
                          style: const TextStyle(
                            fontFamily: 'IBM Plex Mono',
                            color: _red,
                            fontSize: 12,
                            letterSpacing: 1,
                          ),
                        ),
                      ),
                      const SizedBox(height: 22),
                      FittedBox(
                        child: Text(
                          '${code!.substring(0, 4)} ${code.substring(4)}',
                          style: const TextStyle(
                            fontFamily: 'IBM Plex Mono',
                            fontSize: 48,
                            letterSpacing: 2,
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),
                      LinearProgressIndicator(
                        value: remaining / _period,
                        backgroundColor: Colors.white12,
                        color: _red,
                      ),
                      const SizedBox(height: 24),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: () => _copy(code),
                          icon: const Icon(Icons.copy),
                          label: const Text('COPY CODE'),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 26),
                const Text(
                  'CODE INTERVAL',
                  style: TextStyle(
                    fontFamily: 'IBM Plex Mono',
                    letterSpacing: 1.4,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  children: [
                    for (var i = 5; i <= 10; i++)
                      ChoiceChip(
                        label: Text('$i s'),
                        selected: _period == i,
                        onSelected: (_) => _changePeriod(i),
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                const Text(
                  'Five-second codes can expire before you return to the vault. Ten seconds is the practical default.',
                  style: TextStyle(color: Colors.white54, fontSize: 12),
                ),
              ],
              if (_message != null) ...[
                const SizedBox(height: 16),
                Text(_message!, style: const TextStyle(color: _red)),
              ],
              const SizedBox(height: 40),
              const Text(
                'OFFLINE  •  PRIVATE  •  DEVICE LOCK REQUIRED',
                style: TextStyle(
                  fontFamily: 'IBM Plex Mono',
                  color: Colors.white38,
                  fontSize: 10,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _panel(Widget child) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(22),
    decoration: BoxDecoration(
      color: const Color(0xff151515),
      borderRadius: BorderRadius.circular(24),
      border: Border.all(color: Colors.white12),
    ),
    child: child,
  );
}
