// App State
const API_BASE_URL = (window.location.protocol === 'file:' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) &&
    window.location.port !== '3000'
    ? 'http://localhost:3000'
    : '';

function apiUrl(path) {
    return `${API_BASE_URL}${path}`;
}

function getAppointmentDuration(packageName) {
    if (packageName === '10-Minute Demo Call') return 10;
    if (packageName === '60-Day Video Programme') return null;
    return 30;
}

let state = {
    currentModalStep: 1,
    currency: 'INR'
};

const packagePrices = {
    '10-Minute Demo Call': { INR: '₹199', USD: '$2.50' },
    'Audio Programme': { INR: '₹2,499 one-time', USD: '$39 one-time' },
    'Video Programme': { INR: '₹3,999 one-time', USD: '$49 one-time' },
    '60-Day Video Programme': { INR: '₹24,999', USD: '$299' }
};

let datePicker = null;
let dateOfBirthPicker = null;
let lastCalendarEvent = null;

        window.addEventListener('DOMContentLoaded', () => {
            const dateInput = document.getElementById('input-date');
            const dateOfBirthInput = document.getElementById('input-dob');
            const timeInput = document.getElementById('input-time');
            const today = new Date();

            if (dateOfBirthInput) {
                const todayInIndia = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
                dateOfBirthPicker = flatpickr(dateOfBirthInput, {
                    dateFormat: 'Y-m-d',
                    maxDate: todayInIndia,
                    allowInput: false
                });
            }
            if (dateInput) {
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                datePicker = flatpickr(dateInput, {
                    dateFormat: 'Y-m-d',
                    minDate: tomorrow,
                    maxDate: new Date(today.getTime() + 366 * 24 * 60 * 60 * 1000)
                });
                dateInput.addEventListener('change', () => {
                    populateTimeSlots();
                });
            }
            if (timeInput) {
                timeInput.addEventListener('change', () => {
                    setAvailabilityStatus('');
                    updateBookingDescription();
                });
            }
            document.getElementById('retry-availability').addEventListener('click', populateTimeSlots);

            initializeTestimonials();
        });

        function initializeTestimonials() {
            const carousel = document.getElementById('testimonial-carousel');
            const track = document.getElementById('testimonial-slides');
            const status = document.getElementById('testimonial-status');
            const previousButton = document.getElementById('testimonial-previous');
            const nextButton = document.getElementById('testimonial-next');
            const slides = track ? Array.from(track.children) : [];

            if (!carousel || !track || slides.length < 2 || !status || !previousButton || !nextButton) {
                return;
            }

            let currentSlide = 0;
            let timerId;
            let isMoving = false;
            let manuallyPaused = false;

            function isPaused() {
                return manuallyPaused || document.hidden;
            }

            function toggleAutoplay() {
                manuallyPaused = !manuallyPaused;
                status.textContent = manuallyPaused
                    ? 'Autoplay paused. Activate a testimonial card to resume.'
                    : 'Autoplay resumed.';
                scheduleNextSlide();
            }

            function updateSlideAccessibility() {
                const visibleCount = window.matchMedia('(min-width: 768px)').matches ? 3 : 1;
                Array.from(track.children).forEach((slide, index) => {
                    slide.setAttribute('aria-label', `Testimonial ${index + 1} of ${slides.length}`);
                    slide.setAttribute('aria-hidden', String(index >= visibleCount));
                });
                status.textContent = `Testimonial ${currentSlide + 1} of ${slides.length} is now first`;
            }

            function finishMove() {
                track.removeEventListener('transitionend', handleTransitionEnd);
                track.style.transition = 'none';
                track.style.transform = 'translateX(0)';
                track.offsetWidth;
                track.style.transition = '';
                isMoving = false;
                updateSlideAccessibility();
                scheduleNextSlide();
            }

            function handleTransitionEnd(event) {
                if (event.target !== track || event.propertyName !== 'transform') {
                    return;
                }

                if (currentDirection > 0) {
                    track.append(track.firstElementChild);
                }
                finishMove();
            }

            let currentDirection = 1;

            function moveSlide(direction) {
                if (isMoving) {
                    return;
                }

                const firstSlide = track.firstElementChild;
                const secondSlide = firstSlide.nextElementSibling;
                const step = secondSlide.offsetLeft - firstSlide.offsetLeft;
                currentDirection = direction;
                currentSlide = (currentSlide + direction + slides.length) % slides.length;
                isMoving = true;

                if (direction < 0) {
                    track.style.transition = 'none';
                    track.prepend(track.lastElementChild);
                    track.style.transform = `translateX(-${step}px)`;
                    track.offsetWidth;
                    track.style.transition = '';
                    track.addEventListener('transitionend', handleTransitionEnd);
                    track.style.transform = 'translateX(0)';
                    return;
                }

                track.addEventListener('transitionend', handleTransitionEnd);
                track.style.transform = `translateX(-${step}px)`;
            }

            previousButton.addEventListener('click', () => moveSlide(-1));
            nextButton.addEventListener('click', () => moveSlide(1));

            function scheduleNextSlide() {
                window.clearTimeout(timerId);
                if (!isPaused() && !isMoving) {
                    timerId = window.setTimeout(() => moveSlide(1), 20000);
                }
            }

            carousel.addEventListener('click', (event) => {
                if (event.target.closest('.testimonial-slide')) {
                    toggleAutoplay();
                }
            });
            carousel.addEventListener('keydown', (event) => {
                if (
                    (event.key === 'Enter' || event.key === ' ') &&
                    event.target.closest('.testimonial-slide')
                ) {
                    event.preventDefault();
                    toggleAutoplay();
                }
            });
            document.addEventListener('visibilitychange', scheduleNextSlide);

            updateSlideAccessibility();
            scheduleNextSlide();
        }

        function formatTime(minutes) {
            const hour = Math.floor(minutes / 60);
            const minute = minutes % 60;
            const period = hour >= 12 ? 'PM' : 'AM';
            const displayHour = hour % 12 || 12;
            return `${displayHour}:${String(minute).padStart(2, '0')} ${period}`;
        }

        function setAvailabilityStatus(message) {
            const status = document.getElementById('availability-status');
            status.textContent = message;
            status.classList.toggle('hidden', !message);
            document.getElementById('retry-availability').classList.add('hidden');
        }

        async function populateTimeSlots() {
            const timeInput = document.getElementById('input-time');
            const selectedDate = document.getElementById('input-date').value;
            setAvailabilityStatus('');
            timeInput.replaceChildren(new Option('Loading available times…', ''));
            if (!selectedDate) {
                timeInput.disabled = true;
                updateBookingDescription();
                return;
            }

            timeInput.disabled = true;
            try {
                const response = await fetch(apiUrl(`/api/availability?date=${encodeURIComponent(selectedDate)}`));
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Could not load appointment times.');
                if (document.getElementById('input-date').value !== selectedDate) return;

                const booked = new Set(result.bookedTimes);
                const blocked = new Set(result.blockedTimes || []);
                if (result.dateBlocked) {
                    timeInput.replaceChildren(new Option('No appointments available on this date', ''));
                    setAvailabilityStatus('Appointments are unavailable on this date. Please choose another date.');
                    updateBookingDescription();
                    return;
                }
                timeInput.replaceChildren(new Option('Select a time slot', ''));
                const slotDuration = getAppointmentDuration(document.getElementById('selected-package-input').value);
                const openingTime = 9 * 60;
                const closingTime = 21 * 60 + 30;
                const interval = 45;
                for (let start = openingTime; start <= closingTime; start += interval) {
                    const hour = String(Math.floor(start / 60)).padStart(2, '0');
                    const minute = String(start % 60).padStart(2, '0');
                    const value = `${hour}:${minute}`;
                    const label = slotDuration === null
                        ? `${formatTime(start)} IST · no fixed end time`
                        : `${formatTime(start)} - ${formatTime(start + slotDuration)} IST`;
                    const unavailable = booked.has(value) || blocked.has(value);
                    const option = new Option(unavailable ? `${label} (unavailable)` : label, value, false, false);
                    option.disabled = unavailable;
                    timeInput.add(option);
                }
                timeInput.disabled = false;
            } catch (error) {
                if (document.getElementById('input-date').value !== selectedDate) return;
                timeInput.replaceChildren(new Option('Appointment times could not be loaded', ''));
                const message = error instanceof TypeError && API_BASE_URL
                    ? 'Booking service is not reachable at http://localhost:3000. Start it from the rcoachc folder with "node server.js", then retry.'
                    : error.message;
                setAvailabilityStatus(message);
                document.getElementById('retry-availability').classList.remove('hidden');
            }
            updateBookingDescription();
        }

        function updateBookingDescription() {
            const dateInput = document.getElementById('input-date');
            const timeInput = document.getElementById('input-time');
            const description = document.getElementById('modal-description');
            const packageName = document.getElementById('selected-package-input').value;
            const price = packagePrices[packageName][state.currency];
            const selectedTime = timeInput.value;
            const durationNote = getAppointmentDuration(packageName) === null
                ? ' · Session duration to be confirmed with the team.'
                : '';
            if (selectedTime) {
                description.innerText = `${price} · Selected start: ${dateInput.value} · ${formatTimeInput(selectedTime)} IST${durationNote}`;
            } else if (dateInput.value) {
                description.innerText = `${price} · Choose an available start time.${durationNote}`;
            } else {
                description.innerText = `${price} · Choose a preferred date and time for your conversation.${durationNote}`;
            }
        }

        function formatTimeInput(value) {
            const [hour, minute] = value.split(':').map(Number);
            return formatTime(hour * 60 + minute);
        }

        document.querySelectorAll('[data-currency-toggle]').forEach((button) => {
            button.addEventListener('click', () => setCurrency(button.dataset.currencyToggle));
        });

        function setCurrency(currency) {
            if (currency !== 'INR' && currency !== 'USD') return;

            state.currency = currency;
            document.querySelectorAll('[data-currency-price]').forEach((price) => {
                price.innerText = currency === 'INR' ? price.dataset.priceInr : price.dataset.priceUsd;
            });
            if (document.getElementById('booking-modal') && !document.getElementById('booking-modal').classList.contains('hidden')) {
                updateBookingDescription();
            }
            document.querySelectorAll('[data-currency-toggle]').forEach((button) => {
                const isSelected = button.dataset.currencyToggle === currency;
                button.setAttribute('aria-pressed', String(isSelected));
                button.classList.toggle('bg-brand-gold', isSelected);
                button.classList.toggle('text-black', isSelected);
                button.classList.toggle('text-brand-muted', !isSelected);
            });
        }

        // Mobile Menu Toggle
        document.getElementById('mobile-menu-btn').addEventListener('click', toggleMobileMenu);
        function toggleMobileMenu() {
            const menu = document.getElementById('mobile-menu');
            menu.classList.toggle('hidden');
        }

        // Phase Tab Switcher
        function switchPhase(phaseNum) {
            // Update Tab Buttons
            document.querySelectorAll('.phase-btn').forEach((btn, idx) => {
                if (idx + 1 === phaseNum) {
                    btn.classList.add('bg-brand-gold', 'text-black', 'shadow-md');
                    btn.classList.remove('text-brand-muted');
                } else {
                    btn.classList.remove('bg-brand-gold', 'text-black', 'shadow-md');
                    btn.classList.add('text-brand-muted');
                }
            });

            // Update Content Panels
            document.querySelectorAll('.phase-content').forEach((panel, idx) => {
                if (idx + 1 === phaseNum) {
                    panel.classList.remove('hidden');
                } else {
                    panel.classList.add('hidden');
                }
            });
        }

        // FAQ Accordion Toggle
        function toggleFaq(button) {
            const answer = button.nextElementSibling;
            const icon = button.querySelector('i');

            if (answer.classList.contains('hidden')) {
                answer.classList.remove('hidden');
                icon.classList.add('rotate-180');
            } else {
                answer.classList.add('hidden');
                icon.classList.remove('rotate-180');
            }
        }

        // Booking Modal Management
        function openBookingModal(pkgName = '10-Minute Demo Call') {
            document.getElementById('selected-package-input').value = pkgName;
            const isDemoCall = pkgName === '10-Minute Demo Call';
            document.getElementById('time-slot-field').classList.remove('hidden');
            document.getElementById('modal-title').innerText = isDemoCall
                ? 'Book a 10-Minute Demo Call'
                : 'Choose a Companionship Option';
            document.getElementById('booking-modal').classList.remove('hidden');
            resetModalSteps();
            if (datePicker) datePicker.clear();
            if (dateOfBirthPicker) dateOfBirthPicker.clear();
            document.getElementById('input-time').replaceChildren(new Option('Select a date first', ''));
            document.getElementById('input-time').disabled = true;
            document.getElementById('input-name').value = '';
            document.getElementById('input-email').value = '';
            document.getElementById('input-phone').value = '';
            setAvailabilityStatus('');
            document.getElementById('booking-form-status').classList.add('hidden');
            document.getElementById('booking-form-status').textContent = '';
            updateBookingDescription();
        }

        function closeBookingModal() {
            document.getElementById('booking-modal').classList.add('hidden');
        }

        function resetModalSteps() {
            state.currentModalStep = 1;
            document.getElementById('step-1').classList.remove('hidden');
            document.getElementById('step-2').classList.add('hidden');
            document.getElementById('input-date').required = true;
            document.getElementById('input-time').required = true;
            ['input-name', 'input-email', 'input-phone', 'input-dob'].forEach((id) => {
                document.getElementById(id).required = false;
            });
            document.getElementById('modal-success').classList.add('hidden');
            document.getElementById('intake-form').classList.remove('hidden');
            document.getElementById('modal-step-badge').innerText = 'Step 1 of 2 • Choose a slot';
        }

        function nextStep(stepNum) {
            if (stepNum === 2) {
                const dateInput = document.getElementById('input-date');
                const timeInput = document.getElementById('input-time');
                if (!dateInput.reportValidity()) return;
                if (timeInput.disabled) {
                    if (document.getElementById('availability-status').classList.contains('hidden')) {
                        setAvailabilityStatus('Available times are still loading or could not be loaded. Please retry.');
                    }
                    return;
                }
                if (!timeInput.reportValidity()) return;
            }

            state.currentModalStep = stepNum;
            const isScheduleStep = stepNum === 1;
            document.getElementById('input-date').required = isScheduleStep;
            document.getElementById('input-time').required = isScheduleStep;
            ['input-name', 'input-email', 'input-phone', 'input-dob'].forEach((id) => {
                document.getElementById(id).required = !isScheduleStep;
            });
            document.getElementById('step-1').classList.add('hidden');
            document.getElementById('step-2').classList.add('hidden');

            document.getElementById(`step-${stepNum}`).classList.remove('hidden');
            const stepLabel = stepNum === 1 ? 'Choose a slot' : 'Contact info';
            document.getElementById('modal-step-badge').innerText = `Step ${stepNum} of 2 • ${stepLabel}`;
        }

        function makeCalendarLinks(appointment) {
            const calendarActions = document.getElementById('calendar-link-actions');
            const calendarDurationNote = document.getElementById('calendar-duration-note');
            const duration = getAppointmentDuration(appointment.package);
            if (duration === null) {
                lastCalendarEvent = null;
                calendarActions.classList.add('hidden');
                calendarDurationNote.classList.remove('hidden');
                return;
            }

            calendarActions.classList.remove('hidden');
            calendarDurationNote.classList.add('hidden');
            const [year, month, day] = appointment.date.split('-').map(Number);
            const [hour, minute] = appointment.time.split(':').map(Number);
            const start = new Date(Date.UTC(year, month - 1, day, hour, minute));
            const end = new Date(start.getTime() + duration * 60000);
            const formatCalendarDate = (date) => {
                return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}00`;
            };
            const title = `Re You Life - ${appointment.package}`;
            const startText = formatCalendarDate(start);
            const endText = formatCalendarDate(end);
            const googleUrl = new URL('https://calendar.google.com/calendar/render');
            googleUrl.search = new URLSearchParams({
                action: 'TEMPLATE',
                text: title,
                dates: `${startText}+0530/${endText}+0530`,
                details: 'Appointment request with Re You Life. The team will contact you to confirm.',
                ctz: 'Asia/Kolkata'
            });
            document.getElementById('google-calendar-link').href = googleUrl.toString();
            lastCalendarEvent = { title, date: appointment.date, time: appointment.time, duration };
        }

        function downloadCalendarEvent() {
            if (!lastCalendarEvent) return;
            const { title, date, time, duration } = lastCalendarEvent;
            const [year, month, day] = date.split('-').map(Number);
            const [hour, minute] = time.split(':').map(Number);
            const start = new Date(Date.UTC(year, month - 1, day, hour, minute) - 330 * 60000);
            const end = new Date(start.getTime() + duration * 60000);
            const formatIcsDate = (value) => value.toISOString()
                .replace(/[-:]/g, '')
                .replace(/\.\d{3}/, '');
            const escapeIcs = (value) => value.replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n');
            const content = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//Re You Life//Appointment//EN',
                'BEGIN:VEVENT',
                `UID:${crypto.randomUUID()}@reyou.life`,
                `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
                `DTSTART:${formatIcsDate(start)}`,
                `DTEND:${formatIcsDate(end)}`,
                `SUMMARY:${escapeIcs(title)}`,
                'DESCRIPTION:Appointment request with Re You Life. The team will contact you to confirm.',
                'END:VEVENT',
                'END:VCALENDAR'
            ].join('\r\n');
            const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 're-you-life-appointment.ics';
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        async function handleFormSubmit(e) {
            e.preventDefault();
            const selectedPackage = document.getElementById('selected-package-input').value;
            const status = document.getElementById('booking-form-status');
            const submitButton = e.currentTarget.querySelector('[type="submit"]');
            const payload = {
                package: selectedPackage,
                name: document.getElementById('input-name').value,
                email: document.getElementById('input-email').value,
                phone: document.getElementById('input-phone').value.trim(),
                dateOfBirth: document.getElementById('input-dob').value,
                date: document.getElementById('input-date').value,
                time: document.getElementById('input-time').value,
                currency: state.currency,
                price: packagePrices[selectedPackage][state.currency],
            };
            status.classList.add('hidden');
            submitButton.disabled = true;
            document.getElementById('booking-submit-label').textContent = 'Saving request…';
            try {
                const response = await fetch(apiUrl('/api/bookings'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Your appointment could not be saved.');

                makeCalendarLinks(payload);
                document.getElementById('intake-form').classList.add('hidden');
                document.getElementById('confirm-name').textContent = payload.name;
                document.getElementById('confirm-pkg').textContent = payload.package;
                document.getElementById('confirm-price').textContent = payload.price;
                document.getElementById('confirm-date').textContent = `${payload.date} at ${formatTimeInput(payload.time)} IST`;
                document.getElementById('modal-success').classList.remove('hidden');
                document.getElementById('modal-step-badge').textContent = 'Request saved';
            } catch (error) {
                status.textContent = error.message;
                status.classList.remove('hidden');
                if (error.message.includes('just booked')) {
                    await populateTimeSlots();
                    status.textContent = error.message;
                    status.classList.remove('hidden');
                }
            } finally {
                submitButton.disabled = false;
                document.getElementById('booking-submit-label').textContent = 'Request this appointment';
            }
        }

        document.getElementById('download-calendar-event').addEventListener('click', downloadCalendarEvent);

        window.addEventListener('pointermove', (event) => {
            if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;

            document.documentElement.style.setProperty('--pointer-x', `${event.clientX}px`);
            document.documentElement.style.setProperty('--pointer-y', `${event.clientY}px`);
        });
