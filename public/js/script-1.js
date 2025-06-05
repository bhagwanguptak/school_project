// script.js - Enhanced scroll behavior for fixed navbar & other UI enhancements
document.addEventListener("DOMContentLoaded", () => {
  // Cache elements
  const navbar = document.querySelector('.navbar-custom'); // Use .navbar-custom
  const scrollLinks = document.querySelectorAll('a.nav-link[href^="#"]');
  
  // Calculate navbar height
  const getNavbarHeight = () => {
    if (!navbar) return 0; 
    // Simpler check for fixed navbar height
    return navbar.offsetHeight;
  };

  // Enhanced smooth scroll function
  const smoothScroll = (e) => {
    e.preventDefault();
    const href = e.currentTarget.getAttribute('href');
    
    if (href && href.length > 1 && href.startsWith('#')) {
        const targetId = href.substring(1); // Get ID without '#'
        const target = document.getElementById(targetId); // Use getElementById for speed
        
        if (target) {
          const navbarHeight = getNavbarHeight();
          // Wait for any layout shifts from dynamic content loading from admin.js
          // A more robust way would be for admin.js to signal when it's done loading critical layout parts.
          // For now, a small timeout can help, or rely on scroll-padding-top.
          
          // Using getBoundingClientRect and window.pageYOffset is more reliable
          const targetPosition = target.getBoundingClientRect().top + window.pageYOffset;
          const offsetPosition = targetPosition - navbarHeight;
          
          window.scrollTo({
            top: offsetPosition,
            behavior: 'smooth'
          });
          
          const navbarToggler = navbar ? navbar.querySelector('.navbar-toggler') : null;
          const navbarCollapse = navbar ? navbar.querySelector('.navbar-collapse') : null;

          if (navbarToggler && navbarCollapse && navbarCollapse.classList.contains('show')) {
             if (getComputedStyle(navbarToggler).display !== 'none') {
                const bsCollapse = bootstrap.Collapse.getInstance(navbarCollapse) || new bootstrap.Collapse(navbarCollapse, { toggle: false });
                bsCollapse.hide();
             }
          }
        }
    }
  };

  scrollLinks.forEach(link => {
    link.addEventListener('click', smoothScroll);
  });

  // Adjust scroll position on page load if URL has hash
  if (window.location.hash && window.location.hash.length > 1) {
    const targetId = window.location.hash.substring(1);
    const target = document.getElementById(targetId);
    if (target) {
      setTimeout(() => { // Timeout ensures admin.js might have set content affecting layout
        const navbarHeight = getNavbarHeight();
        const targetPosition = target.getBoundingClientRect().top + window.pageYOffset;
        const offsetPosition = targetPosition - navbarHeight;
        window.scrollTo({
          top: offsetPosition,
          behavior: 'auto' 
        });
      }, 200); // Slightly increased timeout
    }
  }

  // Animation for elements on scroll
  const revealElements = document.querySelectorAll('.reveal, .reveal-left, .reveal-right');
  const observerOptions = {
    root: null, // relative to document viewport
    rootMargin: '0px',
    threshold: 0.1 // 10% of element visible
  };

  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('active');
        observer.unobserve(entry.target); // Stop observing once animated
      }
    });
  }, observerOptions);

  revealElements.forEach(el => {
    revealObserver.observe(el);
  });

  // Dynamic active nav link based on scroll position
  const sections = document.querySelectorAll('section[id]');
  const navLi = document.querySelectorAll('.navbar-nav .nav-item .nav-link');

  window.addEventListener('scroll', () => {
    let current = '';
    const navbarHeight = getNavbarHeight() + 20; // Add a small offset

    sections.forEach(section => {
      const sectionTop = section.offsetTop - navbarHeight; // Adjust for navbar
      const sectionHeight = section.clientHeight;
      if (pageYOffset >= sectionTop && pageYOffset < sectionTop + sectionHeight) {
        current = section.getAttribute('id');
      }
    });
    
    // If near bottom of page, and last section is not filling viewport, highlight last nav item
    if (window.innerHeight + window.pageYOffset >= document.body.offsetHeight - 2 && sections.length > 0) {
        current = sections[sections.length -1].getAttribute('id');
    }


    navLi.forEach(link => {
      link.classList.remove('active');
      const href = link.getAttribute('href');
      if (href && href.substring(1) === current) {
        link.classList.add('active');
      }
    });

    // Special case for top of page (Hero)
    if (pageYOffset < sections[0].offsetTop - navbarHeight) {
        navLi.forEach(link => link.classList.remove('active'));
        const homeLink = document.querySelector('.navbar-nav .nav-item .nav-link[href="#hero"]');
        if (homeLink) homeLink.classList.add('active');
    }
  });



const contactForm = document.getElementById('mainContactForm');
  const contactFormStatusDiv = document.getElementById('contactFormStatus');
  const contactSubmitButton = contactForm ? contactForm.querySelector('button[type="submit"]') : null;

  if (contactForm && contactSubmitButton && contactFormStatusDiv) {
    contactForm.addEventListener('submit', async function (event) {
      event.preventDefault(); // Prevent default browser submission

      // Bootstrap validation (should already be part of your setup)
      if (!contactForm.checkValidity()) {
        event.stopPropagation();
        contactForm.classList.add('was-validated');
        contactFormStatusDiv.innerHTML = `<div class="alert alert-warning" role="alert">Please fill out all required fields correctly.</div>`;
        return;
      }
      contactForm.classList.add('was-validated'); // Ensure styles are shown

      const formData = new FormData(contactForm);
      const data = {};
      formData.forEach((value, key) => { data[key] = value; });

      // UI updates for loading state
      contactSubmitButton.disabled = true;
      contactSubmitButton.innerHTML = 'Sending... <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
      contactFormStatusDiv.innerHTML = ''; // Clear previous messages

      try {
        const response = await fetch('/api/submit-contact', { // Ensure this matches your server route
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
        });

        const result = await response.json(); // Expecting JSON from the server

        if (response.ok && result.success) {
          if (result.action === 'whatsapp' && result.whatsappUrl) {
            // WhatsApp redirect
            contactFormStatusDiv.innerHTML = `<div class="alert alert-info" role="alert">${result.message || 'Redirecting to WhatsApp...'}</div>`;
            window.location.href = result.whatsappUrl;
            // Form reset might not be necessary if redirecting, but good practice for other cases
            // contactForm.reset();
            // contactForm.classList.remove('was-validated');
          } else if (result.action === 'email') {
            // Email sent
            contactFormStatusDiv.innerHTML = `<div class="alert alert-success" role="alert">${result.message || 'Message sent successfully!'}</div>`;
            contactForm.reset();
            contactForm.classList.remove('was-validated');
          } else {
             // Should not happen if server logic is correct
            contactFormStatusDiv.innerHTML = `<div class="alert alert-warning" role="alert">${result.message || 'Request processed, but action unclear.'}</div>`;
          }
        } else {
          // Error from server (e.g., validation failed server-side, or other server error)
          contactFormStatusDiv.innerHTML = `<div class="alert alert-danger" role="alert">${result.message || 'An error occurred. Please try again.'}</div>`;
        }
      } catch (error) {
        console.error('Error submitting contact form:', error);
        contactFormStatusDiv.innerHTML = `<div class="alert alert-danger" role="alert">A network error occurred. Please check your connection and try again.</div>`;
      } finally {
        // Re-enable button unless it was a WhatsApp redirect
        if (!contactFormStatusDiv.innerHTML.includes('Redirecting to WhatsApp')) {
            contactSubmitButton.disabled = false;
            contactSubmitButton.innerHTML = 'Send Message <i class="bi bi-send-fill ms-2"></i>';
        }
      }
    });
  }
});